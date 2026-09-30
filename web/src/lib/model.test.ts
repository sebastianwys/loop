import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelPage } from "../components/ModelPage";
import { SAMPLE } from "./data";
import {
  ARMS, AVERAGE, LONG_RUN, NOMINAL_COVERAGE, NO_CHANGE, SHIPPED, WHY_SHIPPED, admissionSentences, allUnderCover, armGap, asPercent,
  bandCall, bandCut, bandExtremes, bandPairs, bandWords, beatenEverywhere, bestAt, closerAt, closestTo, coverageRange, cutWords,
  edgeSentence, edgeTest, edgesOver, errorCut, errorCuts, extraFit, horizonPhrase, horizonsIn, joinList, leaderboard, lossSentence,
  lossesOf, matchedBy, matchedEverywhere, matchedPhrase, meanVerdict, modelLabel, modelsIn, pAt, pBound, pList, pPhrase, pRange,
  pText, pairedOrigins, pairedWith, points, proseName, quantile, quarterLabel, revisionOf, ridgeVerdict, rowAt, ruleCall,
  ruleSentence, sentenceCase, separatedAt, separatedSentence, separations, settingsPhrase, shiftQuarter, spanPaired, spanRows,
  spanStart, spansIn, spreadOf, tiedWith, widthAgainst, winsAt,
  type AdmissionRow, type BacktestRow, type Loss, type PairedRow, type WalkBand, type WalkPairedRow, type WalkRow,
} from "./model";
import { BACKTEST, WALKFORWARD, WALKFORWARD_LATEST, WALKFORWARD_PAIRED } from "./modelNumbers";
import { DEFAULT_ROUTE } from "./route";
import type { Shell } from "./views";
import type { Metro, YearValues } from "../types";

const row = (model: string, horizon: number, maePct: number, coverage = 0.8, width = 0.1): BacktestRow =>
  ({ model, horizon, maePct, coverage, width, n: 7378 });

// a two horizon table with a clear winner at each: ridge short, the gru long
const TABLE: BacktestRow[] = [
  row(NO_CHANGE, 1, 2.3, 0.87, 0.079),
  row(NO_CHANGE, 4, 7.66, 0.86, 0.201),
  row("ridge", 1, 1.81, 0.76, 0.052),
  row("ridge", 4, 4.47, 0.86, 0.159),
  row(LONG_RUN, 1, 2.02, 0.88, 0.084),
  row(LONG_RUN, 4, 5.13, 0.87, 0.236),
  row(SHIPPED, 1, 1.92, 0.8, 0.063),
  row(SHIPPED, 4, 4.2, 0.87, 0.167),
];

const metro = (name: string, latest: Record<string, unknown>): Metro => ({
  cbsa: name,
  name,
  lat: 0,
  lon: 0,
  years: { 2014: {} as YearValues, 2019: {} as YearValues, 2024: {} as YearValues },
  latest: latest as unknown as Metro["latest"],
  growth: {} as Metro["growth"],
  ptir: { 2014: null, 2019: null, 2024: null },
});

const forecast = (name: string, value: number, lo?: number, hi?: number) =>
  metro(name, {
    hpi_forecast_4q: value,
    hpi_forecast_4q_date: "2026-06",
    hpi_forecast_4q_lo: lo ?? value - 5,
    hpi_forecast_4q_hi: hi ?? value + 5,
  });

describe("the leaderboard the page draws", () => {
  it("puts the classical rules first and the model that ships last", () => {
    expect(modelsIn(TABLE)).toEqual([NO_CHANGE, LONG_RUN, "ridge", SHIPPED]);
  });

  // a retrain that adds a model should widen the table, not silently drop it
  it("keeps a model the backtest adds later, after the ones it knows", () => {
    const extra = [...TABLE, row("transformer", 1, 1.5)];
    expect(modelsIn(extra)[modelsIn(extra).length - 1]).toBe("transformer");
  });

  it("takes its columns from the horizons the backtest scored", () => {
    expect(horizonsIn(TABLE)).toEqual([1, 4]);
    expect(horizonsIn([...TABLE, row("ridge", 8, 10.4)])).toEqual([1, 4, 8]);
  });

  it("leaves a gap where a model has no row at a horizon", () => {
    const board = leaderboard([...TABLE, row("transformer", 1, 1.5)]);
    const added = board.find((entry) => entry.model === "transformer");
    expect(added?.cells.map((cell) => cell?.maePct ?? null)).toEqual([1.5, null]);
  });

  it("marks the row that ships to the map", () => {
    expect(leaderboard(TABLE).filter((entry) => entry.shipped).map((entry) => entry.model)).toEqual([SHIPPED]);
  });

  it("gives every model a readable name and falls back to its id", () => {
    expect(modelLabel(SHIPPED)).toBe("sequence gru");
    expect(modelLabel("gbm")).toBe("gradient boosting");
    expect(modelLabel("transformer")).toBe("transformer");
  });
});

describe("reading a winner off the table", () => {
  it("names the lowest error at a horizon and how far back the next model is", () => {
    expect(bestAt(TABLE, 1)).toEqual({ model: "ridge", maePct: 1.81, runnerUp: SHIPPED, margin: 0.11 });
    expect(bestAt(TABLE, 4)?.model).toBe(SHIPPED);
  });

  it("calls a tie a tie instead of picking by row order", () => {
    const tied = [row("a", 1, 2), row("b", 1, 2)];
    expect(bestAt(tied, 1)?.margin).toBe(0);
  });

  it("has no standing at a horizon nobody scored", () => {
    expect(bestAt(TABLE, 8)).toBeNull();
  });

  // at one quarter the metro mean is 0.10 worse than the gru and ridge 0.11
  // better, so the nearest rival is the one behind it, not the one ahead
  it("finds the nearest rival on whichever side of the model it sits", () => {
    expect(closestTo(TABLE, SHIPPED, 1)).toEqual({ model: LONG_RUN, gap: 0.1 });
    expect(closestTo(TABLE, LONG_RUN, 1)).toEqual({ model: SHIPPED, gap: 0.1 });
    expect(closestTo(TABLE, SHIPPED, 4)).toEqual({ model: "ridge", gap: 0.27 });
  });

  it("lists every horizon where another model is ahead, with the margin", () => {
    expect(lossesOf(TABLE, SHIPPED)).toEqual([{ horizon: 1, winner: "ridge", margin: 0.11 }]);
    expect(lossesOf(TABLE, "ridge")).toEqual([{ horizon: 4, winner: SHIPPED, margin: 0.27 }]);
  });

  // the csvs sort by model name, so ridge's row comes first. a tie read as a
  // defeat for whoever came second said "ahead by 0.00 points"
  it("counts a tie as neither side's loss nor win, in either row order", () => {
    const tied = [row("ridge", 1, 1.8093), row(SHIPPED, 1, 1.8093), row(NO_CHANGE, 1, 2.3)];
    for (const rows of [tied, [tied[1], tied[0], tied[2]]]) {
      expect(lossesOf(rows, SHIPPED)).toEqual([]);
      expect(lossesOf(rows, "ridge")).toEqual([]);
      expect(winsAt(rows, SHIPPED)).toEqual([]);
      expect(winsAt(rows, "ridge")).toEqual([]);
    }
    expect(winsAt([row("ridge", 1, 1.8), row(SHIPPED, 1, 1.81)], "ridge")).toEqual([1]);
  });
});

describe("measuring one model against another", () => {
  it("reports the share of error it removes", () => {
    expect(errorCut(TABLE, SHIPPED, NO_CHANGE, 4)).toBeCloseTo(0.4517, 3);
    expect(asPercent(errorCut(TABLE, SHIPPED, NO_CHANGE, 4))).toBe("45");
  });

  it("reports the share the band narrows by", () => {
    expect(asPercent(bandCut(TABLE, SHIPPED, LONG_RUN, 4))).toBe("29");
  });

  it("returns nothing rather than a number when a row is missing", () => {
    expect(errorCut(TABLE, SHIPPED, "transformer", 4)).toBeNull();
    expect(bandCut(TABLE, "transformer", LONG_RUN, 4)).toBeNull();
    expect(asPercent(null)).toBeNull();
  });

  // the page says "matches or beats", so a rival level with the model counts
  it("finds where a rival is level with or ahead of a model, on error and on band width apart", () => {
    const ridge = matchedBy(TABLE, "ridge", SHIPPED);
    expect(ridge).toEqual({ horizons: [1, 4], error: [1], width: [1, 4] });
    expect(matchedEverywhere(ridge)).toBe(false);
    expect(matchedPhrase(ridge)).toBe("on error at one quarter and on band width at every horizon");
    const level = [row("ridge", 1, 1.92, 0.8, 0.063), row(SHIPPED, 1, 1.92, 0.8, 0.063)];
    expect(matchedEverywhere(matchedBy(level, "ridge", SHIPPED))).toBe(true);
    expect(matchedPhrase(matchedBy(level, "ridge", SHIPPED))).toBe("at every horizon, on error and on band width");
    expect(matchedPhrase(matchedBy(TABLE, NO_CHANGE, SHIPPED))).toBeNull();
  });

  it("claims nothing for a horizon where either side went unscored", () => {
    const blank = [...TABLE.filter((r) => !(r.model === "ridge" && r.horizon === 4)), row("ridge", 4, Number.NaN, 0.86, 0.1)];
    expect(matchedBy(blank, "ridge", SHIPPED).error).toEqual([1]);
    expect(matchedEverywhere(matchedBy([row("ridge", 1, 1.8, 0.8, Number.NaN), row(SHIPPED, 1, 1.9)], "ridge", SHIPPED))).toBe(false);
  });
});

describe("the coverage readings the limits rest on", () => {
  it("reports the worst and the best coverage at a horizon", () => {
    const spread = coverageRange(TABLE, 1);
    expect(spread?.low.model).toBe("ridge");
    expect(spread?.high.model).toBe(LONG_RUN);
  });

  it("says when every model at a horizon falls short of the nominal band", () => {
    expect(allUnderCover(TABLE, 1)).toBe(true);
    expect(allUnderCover([...TABLE, row("wide", 1, 3, 0.95)], 1)).toBe(false);
    expect(allUnderCover(TABLE, 8)).toBe(false);
  });
});

describe("writing the losses out as a sentence", () => {
  it("names a rival once however many horizons it takes", () => {
    expect(lossSentence(lossesOf(TABLE, SHIPPED))).toBe("ridge is ahead at one quarter by 0.11 points");
    expect(lossSentence([
      { horizon: 1, winner: "ridge", margin: 0.11 },
      { horizon: 2, winner: "ridge", margin: 0.09 },
    ])).toBe("ridge is ahead at one quarter by 0.11 points and at two quarters by 0.09 points");
  });

  it("keeps two different rivals apart", () => {
    expect(lossSentence([
      { horizon: 1, winner: "ridge", margin: 0.11 },
      { horizon: 8, winner: "gbm", margin: 0.2 },
    ])).toBe("ridge is ahead at one quarter by 0.11 points, and gradient boosting is ahead at eight quarters by 0.20 points");
  });

  // the page drops this sentence entirely when it is empty, so it must be
  it("says nothing at all when the model lost nowhere", () => {
    expect(lossSentence([])).toBe("");
  });

  it("can be lifted to the start of a sentence", () => {
    expect(sentenceCase("ridge is ahead")).toBe("Ridge is ahead");
    expect(sentenceCase("")).toBe("");
  });
});

describe("writing horizons out in words", () => {
  it("writes one horizon as a quarter and several as quarters", () => {
    expect(horizonPhrase([1])).toBe("one quarter");
    expect(horizonPhrase([2])).toBe("two quarters");
    expect(horizonPhrase([1, 2])).toBe("one and two quarters");
    expect(horizonPhrase([1, 2, 8])).toBe("one, two and eight quarters");
    expect(horizonPhrase([])).toBe("");
  });
});

describe("the origin quarter of a forecast", () => {
  it("reads the quarter out of the month the field is dated", () => {
    expect(quarterLabel("2026-06")).toBe("2026Q2");
    expect(quarterLabel("2026-01")).toBe("2026Q1");
    expect(quarterLabel("2025-12-31")).toBe("2025Q4");
  });

  it("returns nothing for a date it cannot read", () => {
    expect(quarterLabel(null)).toBeNull();
    expect(quarterLabel("latest")).toBeNull();
    expect(quarterLabel("2026-13")).toBeNull();
  });
});

describe("the shipped forecast across the metros on the map", () => {
  const metros = [forecast("A", 1), forecast("B", 3), forecast("C", 5), forecast("D", 7), forecast("E", 9)];

  it("interpolates between ranks the way the ml folder's percentiles do", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.1)).toBeCloseTo(1.4, 6);
    expect(quantile([], 0.5)).toBeNaN();
  });

  it("measures the median and both tails across the metros that carry a forecast", () => {
    const spread = spreadOf(metros, "hpi_forecast_4q");
    expect(spread?.count).toBe(5);
    expect(spread?.median).toBe(5);
    expect(spread?.p10).toBeCloseTo(1.8, 6);
    expect(spread?.p90).toBeCloseTo(8.2, 6);
  });

  it("names the weakest and the strongest metro and counts the ones forecast to fall", () => {
    const spread = spreadOf([...metros, forecast("F", -2)], "hpi_forecast_4q");
    expect(spread?.lowest).toEqual({ name: "F", value: -2 });
    expect(spread?.highest).toEqual({ name: "E", value: 9 });
    expect(spread?.falling).toBe(1);
  });

  it("carries the origin quarter the fields are dated with", () => {
    expect(spreadOf(metros, "hpi_forecast_4q")?.origin).toBe("2026Q2");
  });

  it("has nothing to say when no metro carries the field", () => {
    expect(spreadOf([metro("A", {})], "hpi_forecast_4q")).toBeNull();
    expect(spreadOf([], "hpi_forecast_4q")).toBeNull();
  });

  it("finds the narrowest and the widest band on the map", () => {
    const spans = bandExtremes([forecast("A", 4, 0, 8), forecast("B", 4, -10, 20)], "hpi_forecast_4q");
    expect(spans?.narrow.name).toBe("A");
    expect(spans?.wide.name).toBe("B");
    expect(spans?.wide.hi).toBe(20);
  });

  it("ignores a metro whose band is missing an edge", () => {
    const half = metro("H", { hpi_forecast_4q: 4, hpi_forecast_4q_lo: 1 });
    expect(bandExtremes([half], "hpi_forecast_4q")).toBeNull();
  });
});

describe("printing a number", () => {
  it("keeps two places by default and a dash for nothing", () => {
    expect(points(4.2027)).toBe("4.20");
    expect(points(0.20698, 3)).toBe("0.207");
    expect(points(null)).toBe("-");
    expect(points(undefined)).toBe("-");
    expect(points(Number.NaN)).toBe("-");
  });
});

// the model page over the shipped backtest, as a reader hears it
const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};
const HTML = renderToStaticMarkup(createElement(ModelPage, {
  data: SAMPLE,
  route: { ...DEFAULT_ROUTE, view: "model" },
  go: () => {},
  viewport: { width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false },
  shell,
}));
const plain = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const PAGE = plain(HTML);
// the stretch of the page from an opening marker to the tag that closes it
const part = (open: string, close: string) => {
  const from = HTML.indexOf(open);
  return from < 0 ? "" : plain(HTML.slice(from, HTML.indexOf(close, from)));
};
const READINGS = part('<ul class="model-readings">', "</ul>");
const LIMITS = part("model-limits", "</section>");

// the scored rows at a horizon, lowest error first, and the horizons where the
// gru is strictly lowest. worked out here rather than through the page's own
// readers, so a reader that went wrong could not vouch for itself
const ranked = (horizon: number) =>
  BACKTEST.filter((r) => r.horizon === horizon && Number.isFinite(r.maePct)).sort((a, b) => a.maePct - b.maePct);
const gruLowest = () => horizonsIn(BACKTEST).filter((h) => {
  const [first, second] = ranked(h);
  return first?.model === SHIPPED && (!second || second.maePct > first.maePct);
});

// these read the numbers the page actually publishes. they are here so that a
// retrain cannot quietly turn a sentence on the page into a false one: the
// ones about who wins and whether a band holds render the page and check what
// it says against what the numbers say, so whichever way a retrain lands the
// page has to say that, and the rest are drift alarms on the prose around them
describe("the claims the model page makes about the shipped backtest", () => {
  it("has a row for every model at every horizon it scored", () => {
    const horizons = horizonsIn(BACKTEST);
    expect(horizons).toEqual([1, 2, 4, 8]);
    for (const model of modelsIn(BACKTEST)) {
      for (const horizon of horizons) expect(rowAt(BACKTEST, model, horizon), `${model} ${horizon}q`).not.toBeNull();
    }
  });

  it("scores every model on the same sample count at a horizon", () => {
    for (const horizon of horizonsIn(BACKTEST)) {
      const counts = new Set(BACKTEST.filter((entry) => entry.horizon === horizon).map((entry) => entry.n));
      expect(counts.size, `${horizon}q`).toBe(1);
    }
  });

  it("names the horizons where the sequence gru has the lowest error, which the results section says", () => {
    const lowest = gruLowest();
    expect(READINGS).toContain(lowest.length > 0
      ? `The sequence GRU has the lowest error at ${horizonPhrase(lowest)}.`
      : "The sequence GRU has the lowest error at no horizon in this build.");
  });

  it("names every horizon another model is ahead of the gru, and who and by how much, which the limits say out loud", () => {
    const behind: Loss[] = horizonsIn(BACKTEST).flatMap((h) => {
      const at = ranked(h);
      const mine = at.find((r) => r.model === SHIPPED);
      if (!mine || at[0].model === SHIPPED || at[0].maePct === mine.maePct) return [];
      return [{ horizon: h, winner: at[0].model, margin: Math.round((mine.maePct - at[0].maePct) * 1e4) / 1e4 }];
    });
    if (behind.length === 0) {
      expect(LIMITS).toContain("It loses no horizon.");
      return;
    }
    const at = behind.map((loss) => loss.horizon);
    const wins = gruLowest();
    const heading = at.length === horizonsIn(BACKTEST).length
      ? "It loses every horizon."
      : wins.length > 0 && Math.max(...at) < Math.min(...wins) ? "It loses the short horizons." : `It loses at ${horizonPhrase(at)}.`;
    expect(READINGS).toContain(`It loses at ${horizonPhrase(at)}, where ${lossSentence(behind)}.`);
    expect(LIMITS).toContain(`${heading} ${sentenceCase(lossSentence(behind))}.`);
  });

  // the pipeline never weighs ridge against the gru, so the page says where
  // ridge stands rather than letting the gru's place on the map read as a win
  // over it
  it("says ridge matches or beats the gru at every horizon only while it does, and why the gru ships either way", () => {
    const everywhere = horizonsIn(BACKTEST).every((h) => {
      const ridge = rowAt(BACKTEST, "ridge", h);
      const gru = rowAt(BACKTEST, SHIPPED, h);
      return ridge !== null && gru !== null && ridge.maePct <= gru.maePct && ridge.width <= gru.width;
    });
    expect(PAGE.includes("Ridge matches or beats the GRU at every horizon, on error and on band width.")).toBe(everywhere);
    expect(PAGE).toContain("The GRU ships because the pipeline picks between the two networks, not against ridge.");
  });

  it("has ridge as the nearest rival at eight quarters, by a gap worth the caveat", () => {
    const near = closestTo(BACKTEST, SHIPPED, 8);
    expect(near?.model).toBe("ridge");
    // the page prints this gap as a share of the error it sits inside rather
    // than judging it, so this is a drift alarm and not a claim guard: a rival
    // that closes to within a rerun, or opens past a twentieth, is a different
    // story and the prose around it should be re-read. gbm held this spot at
    // 0.011 until the input set was cut to eleven series on 2026-09-18
    const shipped = rowAt(BACKTEST, SHIPPED, 8);
    expect(near!.gap / shipped!.maePct).toBeLessThan(0.05);
  });

  it("has the window mlp behind the metro's own average at every horizon", () => {
    for (const horizon of horizonsIn(BACKTEST)) {
      const mlp = rowAt(BACKTEST, "windowmlp", horizon);
      const mean = rowAt(BACKTEST, LONG_RUN, horizon);
      expect(mlp!.maePct, `${horizon}q`).toBeGreaterThan(mean!.maePct);
    }
  });

  it("says the eight quarter band fails, and that no model escapes it, only while the backtest says so", () => {
    const shipped = rowAt(BACKTEST, SHIPPED, 8)!;
    const misses = shipped.coverage < NOMINAL_COVERAGE;
    const field = BACKTEST.filter((r) => r.horizon === 8 && Number.isFinite(r.coverage)).sort((a, b) => a.coverage - b.coverage);
    const [low, high] = [field[0], field[field.length - 1]];
    expect(LIMITS).toContain(misses ? "The bands fail at eight quarters." : "The bands hold at eight quarters in this build.");
    expect(LIMITS).toContain(`covers ${points(shipped.coverage)} of outcomes there against a nominal ${points(NOMINAL_COVERAGE)}`);
    expect(LIMITS).toContain(`the field runs ${points(low.coverage)} for ${modelLabel(low.model)} to ${points(high.coverage)} for ${modelLabel(high.model)}`);
    expect(LIMITS.includes("no model on the table escapes it")).toBe(field.every((r) => r.coverage < NOMINAL_COVERAGE));
    // a repair is ruled out only while there is a miss to repair
    expect(LIMITS.includes("would fix the number")).toBe(misses);
  });

  it("has the shipped model cutting the no-change error by more than a third at both long horizons", () => {
    expect(errorCut(BACKTEST, SHIPPED, NO_CHANGE, 4)!).toBeGreaterThan(0.33);
    expect(errorCut(BACKTEST, SHIPPED, NO_CHANGE, 8)!).toBeGreaterThan(0.33);
  });

  it("has the shipped band narrower than the long run average at both long horizons", () => {
    expect(bandCut(BACKTEST, SHIPPED, LONG_RUN, 4)!).toBeGreaterThan(0);
    expect(bandCut(BACKTEST, SHIPPED, LONG_RUN, 8)!).toBeGreaterThan(0);
  });
});

// the page counts quarters rather than typing them, so a moved block edge
// moves the sentences that name it
describe("the quarters the page counts", () => {
  it("moves a quarter on and back across the turn of a year", () => {
    expect(shiftQuarter("2014Q4", 1)).toBe("2015Q1");
    expect(shiftQuarter("2015Q1", -8)).toBe("2013Q1");
    expect(shiftQuarter("2015Q1", 0)).toBe("2015Q1");
    expect(shiftQuarter("2015", 1)).toBeNull();
  });

  // ridge fits the whole train block, the networks stop at the fit end
  it("says how much more of the train block ridge fits on than the networks", () => {
    expect(extraFit("2014Q4", "2017Q4")).toBe("three more years");
    expect(extraFit("2016Q4", "2017Q4")).toBe("one more year");
    expect(extraFit("2015Q2", "2017Q4")).toBe("ten more quarters");
    expect(extraFit("2017Q4", "2017Q4")).toBeNull();
    expect(extraFit("not a quarter", "2017Q4")).toBeNull();
  });
});


// a gap on the table can be luck. the paired test says which are not, and
// every sentence the page builds from it is chosen by the p values it read
describe("reading the paired test", () => {
  const pair = (against: string, horizon: number, pValue: number, difference = -0.1, origins = 18): PairedRow =>
    ({ against, horizon, origins, difference, pValue });
  // the shape of the shipped test: ridge ahead and within chance everywhere,
  // no change and the window MLP separated at two horizons each
  const shipped = [
    pair("ridge", 1, 0.397, 0.08), pair("ridge", 2, 0.1325, 0.13), pair("ridge", 4, 0.9433, 0.03), pair("ridge", 8, 0.717, 0.2),
    pair(NO_CHANGE, 1, 0.091), pair(NO_CHANGE, 2, 0.095), pair(NO_CHANGE, 4, 0.017), pair(NO_CHANGE, 8, 0.018),
    pair(LONG_RUN, 1, 0.548), pair(LONG_RUN, 2, 0.539), pair(LONG_RUN, 4, 0.483), pair(LONG_RUN, 8, 0.555),
    pair("windowmlp", 1, 0.0075), pair("windowmlp", 2, 0.0185), pair("windowmlp", 4, 0.06), pair("windowmlp", 8, 0.144),
  ];
  const HORIZONS = [1, 2, 4, 8];

  it("reads a rival's rows by horizon, leaves out a p the test could not compute, and says where it passes", () => {
    const rows = [pair("ridge", 4, Number.NaN), ...shipped];
    expect(pairedWith(rows, "ridge").map((r) => r.horizon)).toEqual([1, 2, 4, 8]);
    expect(pairedWith([pair("gbm", 1, Number.NaN)], "gbm")).toEqual([]);
    expect(separatedAt(shipped, NO_CHANGE)).toEqual([4, 8]);
    expect(separatedAt(shipped, "ridge")).toEqual([]);
    expect(separatedAt(shipped, "ridge", 0.2)).toEqual([2]);
  });

  it("gives a rival's p values as a range, and the origins the test averaged over", () => {
    expect(pRange(shipped, "ridge")).toEqual({ low: 0.1325, high: 0.9433 });
    expect(pRange(shipped, "gbm")).toBeNull();
    expect(pPhrase({ low: 0.1325, high: 0.9433 })).toBe("p 0.13 to 0.94");
    expect(pPhrase({ low: 0.401, high: 0.404 })).toBe("p 0.40");
    expect(pairedOrigins(shipped)).toBe(18);
    expect(pairedOrigins([...shipped, pair("gbm", 8, 0.5, -0.1, 17)])).toBeNull();
  });

  it("lists what it separates from chance in the table's order, with the side that is closer", () => {
    expect(separations(shipped)).toEqual([
      { against: NO_CHANGE, horizons: [4, 8], closer: "shipped" },
      { against: "windowmlp", horizons: [1, 2], closer: "shipped" },
    ]);
    expect(separations([pair("ridge", 2, 0.01, 0.13)])).toEqual([{ against: "ridge", horizons: [2], closer: "rival" }]);
  });

  it("says what it separates and that it separates nothing else, only as the p values have it", () => {
    expect(separatedSentence(shipped)).toBe("At the 5 percent level it separates the GRU from no change at four and eight quarters and "
      + "from the window MLP at one and two quarters, with the GRU closer every time, and it separates nothing else.");
    const none = shipped.map((r) => ({ ...r, pValue: 0.5 }));
    expect(separatedSentence(none)).toBe("At the 5 percent level it separates no gap on the table from chance.");
    const either = [pair(NO_CHANGE, 4, 0.01), pair("ridge", 1, 0.02, 0.08)];
    expect(separatedSentence(either)).toBe("At the 5 percent level it separates the GRU from no change at four quarters, where the GRU "
      + "is closer and from ridge at one quarter, where ridge is closer, and it separates nothing else.");
    expect(separatedSentence([pair("ridge", 1, Number.NaN)])).toBe("");
  });

  it("calls ridge and the gru tied only while it puts every gap between them down to chance", () => {
    expect(ridgeVerdict(shipped, HORIZONS)).toBe("The paired test above puts every gap between ridge and the GRU down to chance, "
      + `p 0.13 to 0.94, so the two are tied, and the GRU ships because ${WHY_SHIPPED}.`);
    const apart = shipped.map((r) => (r.against === "ridge" && r.horizon === 2 ? { ...r, pValue: 0.01 } : r));
    expect(ridgeVerdict(apart, HORIZONS)).toBe("A penalised linear model is the one to beat on this table: the paired test above "
      + "separates ridge from the GRU at two quarters and puts one, four and eight quarters down to chance.");
    // a horizon the test did not score cannot be called a tie
    expect(ridgeVerdict(shipped.filter((r) => !(r.against === "ridge" && r.horizon === 8)), HORIZONS))
      .toBe("A penalised linear model is the one to beat on this table.");
  });

  it("says no gap against the long run average passes it only while none does", () => {
    expect(meanVerdict(shipped)).toBe("No gap between the GRU and that average passes the paired test above, p 0.48 to 0.56.");
    const far = shipped.map((r) => (r.against === LONG_RUN && r.horizon === 8 ? { ...r, pValue: 0.03 } : r));
    expect(meanVerdict(far)).toBe("The paired test above separates the GRU from that average at eight quarters, the GRU the closer, "
      + "and puts one, two and four quarters down to chance.");
    expect(meanVerdict(shipped.filter((r) => r.against !== LONG_RUN))).toBe("");
  });

  it("names a model mid sentence with its article", () => {
    expect(proseName("windowmlp")).toBe("the window MLP");
    expect(proseName(LONG_RUN)).toBe("the metro mean");
    expect(proseName("transformer")).toBe("transformer");
  });
});

// the admission run is compared seed for seed, and a gain is read against how
// far one set's own seeds spread
describe("reading the admission run", () => {
  const SEEDS = [20260915, 20260916, 20260917, 20260918, 20260919];
  const arm = (name: string, losses: number[]): AdmissionRow[] => losses.map((loss, i) => ({ arm: name, seed: SEEDS[i], loss }));
  // the losses ml/admit.py wrote on its last run
  const run = [
    ...arm(ARMS.nine, [0.01337, 0.013552, 0.013433, 0.013404, 0.013502]),
    ...arm(ARMS.shipped, [0.013195, 0.01345, 0.013297, 0.013261, 0.013183]),
    ...arm(ARMS.rents, [0.013274, 0.013307, 0.013364, 0.013344, 0.013418]),
    ...arm(ARMS.all, [0.013174, 0.013355, 0.013255, 0.013204, 0.013261]),
  ];

  it("counts seed for seed, and reads the gain against the wider spread of the two arms", () => {
    const added = armGap(run, ARMS.all, ARMS.shipped)!;
    expect(added.seeds).toBe(5);
    expect(added.wins).toBe(4);
    expect(added.gain).toBeCloseTo(0.0000274, 9);
    expect(added.spread).toBeCloseTo(0.000267, 9);
    expect(armGap(run, ARMS.all, "an arm nobody ran")).toBeNull();
  });

  it("keeps rents and listing prices out, and says why, only while their gain is inside the spread", () => {
    expect(admissionSentences(run)).toBe("Permits and income beat the set without them on every seed, and ship. Rents and listing "
      + "prices beat the set without them on every seed as well, but added to the shipped set they lower the validation loss by "
      + "less than the spread across one set's seeds, winning on four of five seeds, so they stay out.");
    const clear = run.map((r) => (r.arm === ARMS.all ? { ...r, loss: r.loss - 0.001 } : r));
    expect(admissionSentences(clear)).toContain("by more than the spread across one set's seeds, winning on every seed, though they are not in the shipped set yet.");
    const worse = run.map((r) => (r.arm === ARMS.all ? { ...r, loss: r.loss + 0.001 } : r));
    expect(admissionSentences(worse)).toContain("they do not lower the validation loss at all, so they stay out.");
  });
});

// the walk-forward record, read a span at a time. the page leads with it, so
// every reader here is checked on the shape of the shipped record and then
// on a record moved the way a rerun could move it
describe("reading the walk-forward record", () => {
  const HORIZONS = [1, 2, 4, 8];
  const walk = (model: string, horizon: number, maePct: number, span = "2018Q1", band = "online", more: Partial<WalkRow> = {}): WalkRow =>
    ({ model, horizon, span, band, n: 13938, origins: 34, maePct, coverage: 0.8, width: 0.1, intervalScore: 0.2, ...more });
  const pair = (against: string, horizon: number, pValue: number, difference: number, span = "2018Q1"): WalkPairedRow =>
    ({ span, against, horizon, origins: 34, difference, pValue });
  // the vintage record to four places: gradient boosting lower at every
  // horizon, ridge and the average at three, the gru ahead of the rest
  const ERRORS: Record<string, number[]> = {
    [NO_CHANGE]: [2.2527, 3.8771, 7.4564, 15.4876],
    momentum: [1.7616, 2.6809, 5.1075, 11.4597],
    ridge: [1.5955, 2.3591, 4.6962, 8.0408],
    gbm: [1.5985, 2.3559, 4.1915, 8.1155],
    windowmlp: [1.8049, 2.8177, 5.1775, 10.7914],
    [SHIPPED]: [1.7065, 2.5487, 4.2264, 8.2033],
    [AVERAGE]: [1.6185, 2.4037, 4.4008, 8.093],
  };
  const RECORD = Object.entries(ERRORS).flatMap(([model, maes]) => maes.map((mae, i) => walk(model, HORIZONS[i], mae)));
  // and its paired test: no change and the window mlp behind past chance
  // everywhere, and only the average ahead past chance, at one quarter
  const TESTS: Record<string, [number, number][]> = {
    [NO_CHANGE]: [[0.00029, -0.55], [0.0012, -1.33], [0.00005, -3.23], [0.00023, -7.28]],
    momentum: [[0.496, -0.06], [0.524, -0.13], [0.138, -0.88], [0.11, -3.26]],
    ridge: [[0.115, 0.11], [0.298, 0.19], [0.348, -0.47], [0.458, 0.16]],
    gbm: [[0.245, 0.11], [0.403, 0.19], [0.93, 0.03], [0.919, 0.09]],
    windowmlp: [[0.024, -0.1], [0.038, -0.27], [0.021, -0.95], [0.036, -2.59]],
    [AVERAGE]: [[0.0206, 0.09], [0.152, 0.14], [0.466, -0.17], [0.3, 0.11]],
  };
  const PAIRS = Object.entries(TESTS).flatMap(([against, cells]) => cells.map(([p, d], i) => pair(against, HORIZONS[i], p, d)));
  // the same pairs with some cells moved, the way a rerun could move them
  const moved = (changes: Record<string, [number, number][]>) =>
    PAIRS.map((row) => {
      const hit = changes[row.against]?.find(([h]) => h === row.horizon);
      return hit ? { ...row, pValue: hit[1] } : row;
    });

  it("orders its spans by quarter, and names a span that opens a year by the year", () => {
    expect(spansIn([{ span: "2022Q1" }, { span: "2018Q1" }, { span: "2018Q1" }, { span: "record" }])).toEqual(["2018Q1", "2022Q1"]);
    expect(spanStart("2018Q1")).toBe("2018");
    expect(spanStart("2018Q3")).toBe("2018Q3");
  });

  it("reads one span with one band, the error being the same with either", () => {
    const rows = [walk(SHIPPED, 8, 11.47, "2022Q1", "static"), walk(SHIPPED, 8, 11.47, "2022Q1"), walk(SHIPPED, 8, 8.2)];
    expect(spanRows(rows, "2022Q1").map((r) => r.band)).toEqual(["online"]);
    expect(spanRows(rows, "2022Q1", "static")).toHaveLength(1);
    expect(spanRows(rows, null)).toEqual([]);
    expect(spanPaired([pair(NO_CHANGE, 4, 0.05, -1, "2022Q1"), pair(NO_CHANGE, 4, 0.001, -1)], "2022Q1")).toHaveLength(1);
  });

  it("lists the cut against no change a horizon at a time, and says where it adds to the error instead", () => {
    const cuts = errorCuts(RECORD, SHIPPED, NO_CHANGE);
    expect(cuts.map((c) => c.horizon)).toEqual(HORIZONS);
    expect(cutWords(cuts)).toBe("cuts the error 24, 34, 43 and 47 percent");
    expect(cutWords([{ horizon: 1, cut: 0.1 }, { horizon: 2, cut: -0.05 }]))
      .toBe("cuts the error 10 percent at one quarter and adds 5 percent to it at two quarters");
    expect(cutWords([{ horizon: 4, cut: -0.1 }])).toBe("adds 10 percent to the error");
    expect(cutWords([])).toBe("");
  });

  // two places, a third where two would print a p under the level as the
  // level itself, and a floor under which the table stops counting
  it("prints a p value so it stays on its own side of the level", () => {
    expect(pText(0.00029)).toBe("<0.001");
    expect(pText(0.0012)).toBe("0.001");
    expect(pText(0.0478)).toBe("0.048");
    expect(pText(0.0206)).toBe("0.02");
    expect(pText(0.4964)).toBe("0.50");
    expect(pText(0.0502)).toBe("0.05");
    expect(pText(Number.NaN)).toBe("-");
    expect(pText(null)).toBe("-");
    expect(pList([0.0206])).toBe("p 0.02");
    expect(pList([0.02, 0.031])).toBe("p 0.02 and 0.03");
    expect(pAt(PAIRS, AVERAGE, 1)).toBe(0.0206);
    expect(pAt(PAIRS, "gbm", 3)).toBeNull();
    expect(pAt([pair("gbm", 1, Number.NaN, 0.1)], "gbm", 1)).toBeNull();
  });

  it("bounds a set of p values by the round figure every one is below", () => {
    expect(pBound([0.00029, 0.0012, 0.00005, 0.00023])).toBe("0.002");
    expect(pBound([0.0003])).toBe("0.001");
    expect(pBound([0.002])).toBe("0.003");
    expect(pBound([0.0478])).toBe("0.05");
    expect(pBound([Number.NaN])).toBeNull();
    expect(pBound([])).toBeNull();
  });

  it("finds where the test puts a gap past chance, and on whose side", () => {
    expect(closerAt(PAIRS, NO_CHANGE, "shipped")).toEqual(HORIZONS);
    expect(closerAt(PAIRS, NO_CHANGE, "rival")).toEqual([]);
    expect(closerAt(PAIRS, AVERAGE, "rival")).toEqual([1]);
    expect(closerAt(PAIRS, "gbm", "rival")).toEqual([]);
    expect(beatenEverywhere(PAIRS, HORIZONS)).toEqual([NO_CHANGE, "windowmlp"]);
    expect(beatenEverywhere(PAIRS, [])).toEqual([]);
  });

  // written before the run: better at three of four horizons at 5 percent
  // and worse at none
  it("replaces the gru only where the rule written before the run says so", () => {
    expect(ruleCall(PAIRS, "ridge")).toEqual({ against: "ridge", better: [], worse: [], replaces: false });
    expect(ruleCall(PAIRS, AVERAGE)).toEqual({ against: AVERAGE, better: [1], worse: [], replaces: false });
    const ahead = moved({ ridge: [[1, 0.01], [2, 0.02], [8, 0.03]] });
    expect(ruleCall(ahead, "ridge").replaces).toBe(true);
    // better at three and worse at one is not enough
    expect(ruleCall(moved({ ridge: [[1, 0.01], [2, 0.02], [4, 0.01], [8, 0.03]] }), "ridge"))
      .toEqual({ against: "ridge", better: [1, 2, 8], worse: [4], replaces: false });
  });

  it("states the rule and what it found the way the readme does", () => {
    const calls = ["ridge", AVERAGE].map((m) => ruleCall(PAIRS, m));
    expect(ruleSentence(calls, 4, 4)).toBe("The rule for replacing the GRU was written before the run: ridge or the average "
      + "replaces it only if better at three of four horizons at 5 percent and worse at none. Neither is, so the GRU stays, and "
      + "what the table says is that four models are tied, not that the GRU won.");
    const ahead = ["ridge", AVERAGE].map((m) => ruleCall(moved({ ridge: [[1, 0.01], [2, 0.02], [8, 0.03]] }), m));
    expect(ruleSentence(ahead, 4, 3)).toContain("worse at none. Ridge is, so by that rule it replaces the GRU.");
    expect(ruleSentence([], 4, 4)).toBe("");
  });

  // lower somewhere, never behind past chance, and not ahead past chance at
  // three horizons: gradient boosting, ridge and the average, not momentum,
  // which the gru is lower than everywhere
  it("calls tied only the rivals the record cannot tell from the gru", () => {
    expect(tiedWith(RECORD, PAIRS)).toEqual(["ridge", "gbm", AVERAGE]);
    expect(tiedWith(RECORD, moved({ ridge: [[1, 0.01], [2, 0.02], [8, 0.03]] }))).toEqual(["gbm", AVERAGE]);
    // behind the gru past chance at one horizon is not tied either
    expect(tiedWith(RECORD, moved({ ridge: [[4, 0.03]] }))).toEqual(["gbm", AVERAGE]);
    // a rival the test never scored cannot be called tied
    expect(tiedWith(RECORD, PAIRS.filter((r) => r.against !== "gbm"))).toEqual(["ridge", AVERAGE]);
  });

  // the gaps are the csv's values rounded once: gradient boosting is 0.0349
  // points under the gru at four quarters, which prints as 0.03
  it("names the rivals lower than the gru, the ones lower at more horizons first", () => {
    const edges = edgesOver(RECORD);
    expect(edges.map((e) => `${e.model} ${e.horizons.join("")}`)).toEqual(["ridge 128", "gbm 1248", `${AVERAGE} 128`]);
    expect(edgeSentence(edges, 4)).toBe("Gradient boosting is lower at all four, by 0.03 to 0.19 points, and ridge and the average at three.");
    expect(edgeSentence(edges.slice(0, 1), 4)).toBe("Ridge is lower at three of the four, by 0.11 to 0.19 points.");
    expect(edgeSentence([], 4)).toBe("");
  });

  it("says which of those gaps the paired test separates, and nothing more", () => {
    const edges = edgesOver(RECORD);
    expect(edgeTest(edges, PAIRS)).toBe("The paired test separates none of them from the GRU except the average at one quarter (p 0.02).");
    expect(edgeTest(edges, moved({ [AVERAGE]: [[1, 0.5]] }))).toBe("The paired test separates none of them from the GRU.");
    // a gap past chance with the gru the closer is said to be that
    expect(edgeTest(edges, moved({ ridge: [[4, 0.03]] })))
      .toBe("The paired test separates none of them from the GRU except ridge at four quarters, the GRU the closer (p 0.03) and the "
        + "average at one quarter (p 0.02).");
    expect(edgeTest([], PAIRS)).toBe("");
  });

  // today's index against the vintages: the error moves by 0.0598 points at
  // most, and the cut against no change by 0.79 percentage points
  it("measures how far the revisions move the gru's record", () => {
    const latest = RECORD.map((row) => {
      const now: Record<number, number> = { 1: 1.7001, 2: 2.522, 4: 4.1675, 8: 8.2631 };
      return row.model === SHIPPED ? { ...row, maePct: now[row.horizon] } : row;
    });
    const revision = revisionOf(RECORD, latest)!;
    expect(revision.error).toBeCloseTo(0.0598, 6);
    expect(points(revision.error)).toBe("0.06");
    expect(revision.share).toBeCloseTo(0.0589 / 4.2264, 6);
    expect(revision.cut).toBeCloseTo(0.79, 6);
    expect(revisionOf(RECORD, [])).toBeNull();
    expect(revisionOf(RECORD, latest.filter((r) => r.model === SHIPPED))?.cut).toBeNull();
  });

  // the gru's two bands on 2022 onward, static and online, as the run scored them
  const band = (horizon: number, kind: string, coverage: number, width: number, intervalScore: number) =>
    walk(SHIPPED, horizon, 1, "2022Q1", kind, { coverage, width, intervalScore });
  const BANDS = [
    band(1, "static", 0.8355, 0.0701, 0.1216), band(1, "online", 0.9092, 0.0969, 0.1232),
    band(2, "static", 0.8997, 0.1177, 0.161), band(2, "online", 0.9992, 0.259, 0.2593),
    band(4, "static", 0.8443, 0.1837, 0.2929), band(4, "online", 0.8851, 0.5252, 0.6917),
    band(8, "static", 0.5447, 0.1915, 0.8314), band(8, "online", 0.6457, 0.7243, 1.4798),
    walk("ridge", 8, 1, "2022Q1", "static"),
  ];

  it("pairs the gru's two bands a horizon at a time and applies the band rule", () => {
    const pairs = bandPairs(BANDS, "2022Q1");
    expect(pairs.map((p) => p.horizon)).toEqual(HORIZONS);
    expect(bandPairs(BANDS, "2018Q1")).toEqual([]);
    const call = bandCall(pairs);
    expect(call).toEqual({ horizons: HORIZONS, coversMore: HORIZONS, lower: [], higher: HORIZONS, replaces: false });
    expect(bandWords(call)).toBe("covers more and loses on interval score at every horizon");
    // an online band lower at three of four horizons would replace the static one
    const better = pairs.map((p) => (p.horizon === 1 ? p : { ...p, online: { ...p.online, intervalScore: p.static.intervalScore / 2 } }));
    expect(bandCall(better).replaces).toBe(true);
    expect(bandWords(bandCall(better))).toBe("covers more at every horizon and loses on interval score at one quarter");
    const unscored = pairs.map((p) => ({ ...p, online: { ...p.online, intervalScore: Number.NaN } }));
    expect(bandCall(unscored)).toMatchObject({ lower: [], higher: [], replaces: false });
  });

  it("says how much wider the online band is in words a reader can hold", () => {
    expect(widthAgainst(0.7243, 0.1915)).toBe("almost four times the static width");
    expect(widthAgainst(0.4, 0.1)).toBe("four times the static width");
    expect(widthAgainst(0.43, 0.1)).toBe("more than four times the static width");
    expect(widthAgainst(0.112, 0.1)).toBe("12 percent wider than the static band");
    expect(widthAgainst(0.1002, 0.1)).toBe("about as wide as the static band");
    expect(widthAgainst(0.09, 0.1)).toBe("no wider than the static band");
    expect(widthAgainst(Number.NaN, 0.1)).toBeNull();
  });

  it("gives the gru's band settings once where they agree and a horizon at a time where they do not", () => {
    const setting = (horizon: number, gamma: number, window: number, scaled: boolean | null = true): WalkBand =>
      ({ model: SHIPPED, horizon, gamma, window, scaled });
    const shipped = [setting(1, 0.05, 40), setting(2, 0.05, 16), setting(4, 0.05, 16), setting(8, 0.05, 16)];
    expect(settingsPhrase([...shipped, { ...setting(1, 0, 0, false), model: "momentum" }])).toBe("a step of 0.05 and the per-metro "
      + "scale at every horizon, with a 40 quarter window at one quarter and a 16 quarter window at two, four and eight quarters");
    expect(settingsPhrase([setting(1, 0, 0, false), setting(2, 0, 0, false)]))
      .toBe("no step, no per-metro scale and every outcome realized so far at every horizon");
    expect(settingsPhrase([])).toBe("");
  });

  it("joins a list with or when asked", () => {
    expect(joinList(["ridge", "the average"], "or")).toBe("ridge or the average");
    expect(joinList(["a", "b", "c"])).toBe("a, b and c");
    expect(modelLabel(AVERAGE)).toBe("gru and ridge averaged");
    expect(proseName(AVERAGE)).toBe("the average");
  });
});

// the record the page leads with, read here without the page's own readers so
// a reader that went wrong could not vouch for itself. the claims render the
// page and check what it says, and the rest are drift alarms on the prose
describe("the claims the model page makes about the walk-forward record", () => {
  const spans = [...new Set(WALKFORWARD.map((r) => r.span))].sort();
  const [first, last] = [spans[0], spans[spans.length - 1]];
  const online = (span: string) => WALKFORWARD.filter((r) => r.span === span && r.band === "online");
  const mae = (rows: BacktestRow[], model: string, h: number) => rows.find((r) => r.model === model && r.horizon === h)!.maePct;
  const record = online(first);

  // the module carries every model over the record and, after it, only the
  // rows the page reads there: the gru, its static band, and no change
  it("has every model at every horizon over the record, and the gru and no change over the later span", () => {
    expect(spans).toHaveLength(2);
    const models = [...new Set(record.map((r) => r.model))];
    expect(models).toEqual(expect.arrayContaining([...modelsIn(BACKTEST), AVERAGE]));
    for (const model of models) {
      for (const h of horizonsIn(BACKTEST)) expect(record.some((r) => r.model === model && r.horizon === h), `${model} ${h}`).toBe(true);
    }
    const later = WALKFORWARD.filter((r) => r.span === last);
    expect([...new Set(later.map((r) => `${r.model} ${r.band}`))].sort()).toEqual([`${NO_CHANGE} online`, `${SHIPPED} online`, `${SHIPPED} static`]);
    expect(later).toHaveLength(3 * horizonsIn(BACKTEST).length);
    expect([...new Set(WALKFORWARD.filter((r) => r.band === "static").map((r) => r.span))]).toEqual([last]);
  });

  it("has the gru strictly lowest at no horizon of the record, which the page says rather than crowning it", () => {
    const lowest = horizonsIn(record).filter((h) => record.every((r) => r.model === SHIPPED || r.horizon !== h || r.maePct > mae(record, SHIPPED, h)));
    expect(PAGE.includes("The GRU does not have the lowest error at any horizon.")).toBe(lowest.length === 0);
    expect(PAGE).not.toMatch(/GRU (?:is|was) the best|best model|the GRU wins/i);
  });

  it("has the gru cutting the no-change error by more than a third at four and eight quarters on the record", () => {
    for (const h of [4, 8]) expect(1 - mae(record, SHIPPED, h) / mae(record, NO_CHANGE, h), `${h}q`).toBeGreaterThan(0.33);
  });

  // the page says revisions barely matter, which holds while the largest move
  // is a small share of the error it moves
  it("moves the gru's record error by under a tenth of a point when today's index replaces the vintages", () => {
    const latest = WALKFORWARD_LATEST.filter((r) => r.span === first && r.band === "online");
    const moves = horizonsIn(record).map((h) => Math.abs(mae(record, SHIPPED, h) - mae(latest, SHIPPED, h)));
    expect(Math.max(...moves)).toBeLessThan(0.1);
    expect(PAGE).toContain(`the GRU's error moves by ${points(Math.max(...moves))} points or less at every horizon`);
  });

  it("has the paired test past chance against no change at every horizon of the record", () => {
    const rows = WALKFORWARD_PAIRED.filter((r) => r.span === first && r.against === NO_CHANGE);
    expect(rows.map((r) => r.horizon)).toEqual(horizonsIn(record));
    expect(rows.every((r) => r.pValue < 0.05 && r.difference < 0)).toBe(true);
  });
});

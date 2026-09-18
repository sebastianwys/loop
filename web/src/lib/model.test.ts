import { describe, expect, it } from "vitest";
import {
  LONG_RUN, NOMINAL_COVERAGE, NO_CHANGE, SHIPPED, allUnderCover, asPercent, bandCut, bandExtremes,
  bestAt, closestTo, coverageRange, errorCut, horizonPhrase, horizonsIn, leaderboard, lossSentence,
  lossesOf, modelLabel, modelsIn, points, quantile, quarterLabel, rowAt, sentenceCase, spreadOf,
  type BacktestRow,
} from "./model";
import { BACKTEST } from "./modelNumbers";
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

// these read the numbers the page actually publishes. they are here so that a
// retrain cannot quietly turn a sentence on the page into a false one: if one
// of these fails, the backtest moved and the prose it names has to move too
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

  it("has the sequence gru winning four and eight quarters, which the results section says", () => {
    expect(bestAt(BACKTEST, 4)?.model).toBe(SHIPPED);
    expect(bestAt(BACKTEST, 8)?.model).toBe(SHIPPED);
  });

  it("has ridge ahead at one and two quarters, which the limits say out loud", () => {
    expect(lossesOf(BACKTEST, SHIPPED).map((loss) => [loss.horizon, loss.winner]))
      .toEqual([[1, "ridge"], [2, "ridge"]]);
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

  it("has no model reaching the nominal band at eight quarters, and all of them reaching it nowhere else by luck", () => {
    expect(allUnderCover(BACKTEST, 8)).toBe(true);
    expect(rowAt(BACKTEST, SHIPPED, 8)!.coverage).toBeLessThan(NOMINAL_COVERAGE);
    expect(points(rowAt(BACKTEST, SHIPPED, 8)!.coverage)).toBe("0.66");
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

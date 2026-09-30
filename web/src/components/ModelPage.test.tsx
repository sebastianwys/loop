import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SAMPLE } from "../lib/data";
import {
  EXPANDED_BEFORE, EXPANDED_FOR_ALL_FROM, FIT_END, LONG_RUN, NOMINAL_COVERAGE, SHIPPED, TRAIN_END, closestTo, featureName,
  horizonPhrase, horizonsIn, inWords, joinList, lossSentence, lossesOf, modelsIn, points, proseName, rowAt, sentenceCase,
} from "../lib/model";
import { BACKTEST, INPUTS, PAIRED, PANEL, PANEL_COVERAGE } from "../lib/modelNumbers";
import type { LayoutMode } from "../lib/layout";
import { FIGURE_IDS, FIGURES } from "../lib/modelFigures";
import { DEFAULT_ROUTE } from "../lib/route";
import type { Shell } from "../lib/views";
import type { Latest, MapData, Metro, YearValues } from "../types";
import { ModelPage } from "./ModelPage";

// no dom in this suite, so the markup is read as a string: it proves what a
// reader who cannot see the figures, or is listening to the page, is given

const YEAR: YearValues = {
  hpi: null, income: null, pop: null, age: null, degree_share: null,
  own_rate: null, home_value: null, zhvi: null, zori: null, unemp: null,
};

const LATEST: Latest = {
  zhvi: null, zhvi_date: null, zori: null, zori_date: null, unemp: null, unemp_date: null,
};

function metro(cbsa: string, name: string, latest: Partial<Latest> = {}): Metro {
  return {
    cbsa,
    name,
    lat: 0,
    lon: 0,
    years: { "2014": { ...YEAR }, "2019": { ...YEAR }, "2024": { ...YEAR } },
    latest: { ...LATEST, ...latest },
    growth: { hpi_14_19: null, hpi_19_24: null, income_14_24: null, pop_14_24: null, home_value_14_24: null },
    ptir: { "2014": null, "2019": null, "2024": null },
  };
}

const forecast = (cbsa: string, name: string, near: number, span: number, error: number) =>
  metro(cbsa, name, {
    hpi_forecast_4q: near,
    hpi_forecast_4q_date: "2026-06",
    hpi_forecast_4q_lo: near - span / 2,
    hpi_forecast_4q_hi: near + span / 2,
    hpi_forecast_8q: near * 2,
    hpi_forecast_8q_date: "2026-06",
    hpi_index_error: error,
  });

const METROS = [
  forecast("10180", "Abilene, TX", 1, 19, 2.4),
  forecast("19100", "Dallas-Fort Worth-Arlington, TX", 4, 20, 0.12),
  forecast("34620", "Muncie, IN", 5, 21, 0.9),
  forecast("29020", "Kokomo, IN", 6, 22, 3.1),
  forecast("23420", "Fresno, CA", 9, 20, 0.08),
];

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

const render = (metros: Metro[], mode: LayoutMode = "wide") =>
  renderToStaticMarkup(
    <ModelPage
      data={{ ...SAMPLE, metros } as MapData}
      route={{ ...DEFAULT_ROUTE, view: "model" }}
      go={() => {}}
      viewport={{ width: 1440, height: 900, mode, coarse: false, reducedMotion: false }}
      shell={shell}
    />,
  );

const page = render(METROS);

// what the page reads, so these checks follow a retrain the way the page does
const shipped8 = rowAt(BACKTEST, SHIPPED, 8)!;
const misses8 = shipped8.coverage < NOMINAL_COVERAGE;
const losses = lossSentence(lossesOf(BACKTEST, SHIPPED));
const rival8 = closestTo(BACKTEST, SHIPPED, 8);

// the page as a reader hears it: tags out, apostrophes back, spaces collapsed
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("the model view", () => {
  it("opens with what the model is asked and what it costs to believe it", () => {
    expect(page).toContain("How the forecast is built and judged");
    expect(page).toContain("band coverage at eight quarters");
    // whether the eight quarter band misses is read off the number beside it
    expect(page).toContain(misses8 ? "and that is a miss" : "and that holds");
  });

  it("follows the walkthrough: the panel, the design, the models, the results, the forecast, the limits", () => {
    for (const heading of [
      "The panel", "The evaluation design", "The models", "The results", "The shipped forecast", "The limits",
    ]) {
      expect(page, heading).toContain(heading);
    }
  });

  it("publishes the leaderboard as a table with a header on every column and every row", () => {
    expect(page).toContain('<caption>');
    expect(page).toContain('<th scope="col">model</th>');
    expect(page).toContain('<th scope="col" class="v">8 quarters</th>');
    expect(page).toContain('<th scope="row">sequence gru');
    expect(page).toContain("on the map");
  });

  it("marks the lowest error in a column in words as well as in weight", () => {
    expect(page).toContain("lowest error at this horizon");
  });

  it("gives the reader every published number for a model, not just its error", () => {
    // the sequence gru at eight quarters: error, coverage and band width
    expect(page).toContain(points(shipped8.maePct));
    expect(page).toContain(`cover ${points(shipped8.coverage)}, width ${points(shipped8.width, 3)}`);
  });

  it("says out loud where the shipped model loses, in the readings and in the limits", () => {
    if (!losses) return;
    expect(page).toContain(losses);
    expect(page).toContain(sentenceCase(losses));
  });

  it("names the nearest rival at eight quarters and how thin the win is", () => {
    expect(rival8).not.toBeNull();
    expect(page).toContain(`${points(rival8!.gap)} points`);
    // the size is given against the error rather than called thin or fat
    expect(page).toContain("percent of the error it sits inside");
  });

  it("puts the coverage miss in the limits rather than in a footnote", () => {
    expect(page).toContain(misses8 ? "The bands fail at eight quarters" : "The bands hold at eight quarters");
    expect(page).toContain(`${points(shipped8.coverage)} of outcomes there against a nominal ${points(NOMINAL_COVERAGE)}`);
    // the repair it rules out is named only while there is a miss to repair
    expect(page).toContain(misses8 ? "which is leakage, so it is reported rather than repaired" : "which is leakage, so the window stays where it is");
    expect(page.includes("would fix the number")).toBe(misses8);
  });

  // the coverage it quotes is the backtest band's. the band on the map was
  // calibrated separately, so the limits say whose number it is
  it("says the eight quarter coverage belongs to the backtest band", () => {
    expect(plain(page)).toContain(`backtest band covers ${points(shipped8.coverage)} of outcomes there`);
  });

  it("reads the shipped forecast off the map data rather than repeating a write-up", () => {
    // the five metros above have a median of +5.0 and a weakest of +1.0
    expect(page).toContain("median four quarter forecast across 5 metros is +5.0%");
    expect(page).toContain("the weakest metro is Abilene, TX at +1.0%");
    expect(page).toContain("The eight quarter median is +10.0%");
  });

  // "positive everywhere" is a claim about this export, not a fixed line
  it("counts the metros forecast to fall rather than claiming the model is positive everywhere", () => {
    const falling = render([...METROS, forecast("33700", "Modesto, CA", -2, 18, 1)]);
    expect(falling).toContain("One of them is forecast to fall, the weakest Modesto, CA at -2.0%");
    expect(falling).not.toContain("It is positive everywhere");
    expect(page).toContain("It is positive everywhere");
  });

  it("shows how wide the widest and narrowest bands on the map really are", () => {
    expect(page).toContain("narrowest four quarter band on the map belongs to Abilene, TX");
    expect(page).toContain("The widest belongs to Kokomo, IN");
  });

  it("credits the index error to FHFA and names both ends of it", () => {
    expect(page).toContain("credited to FHFA");
    expect(page).toContain("0.08 percent in Fresno, CA");
    // both ends in hundredths, the precision fhfa and the map print it at
    expect(page).toContain("3.10 percent in Kokomo, IN");
  });

  // the group holds two forecasts beside realized growth, the surprise and
  // fhfa's error, so the page names what is not a forecast rather than
  // counting one of them
  it("says which numbers in the Forecasts group are forecasts", () => {
    const text = page.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    expect(text).not.toContain("One number in the map's Forecasts group");
    expect(text).toContain("Only the expected growth lines in the map's Forecasts group are forecasts");
    expect(text).toContain("the surprise scores the backtest's call");
    expect(text).toContain("last four quarters and the five year annualized trend");
  });

  it("lazy loads every figure at a declared size, with alt text that says what it shows", () => {
    for (const id of FIGURE_IDS) {
      const figure = FIGURES[id];
      expect(page, figure.file).toContain(`src="/figures/${figure.file}"`);
      expect(page, figure.file).toContain(`width="${figure.width}"`);
      expect(page, figure.file).toContain(`height="${figure.height}"`);
      expect(page, figure.file).toContain(figure.alt.slice(0, 40));
    }
    expect(page.split('loading="lazy"')).toHaveLength(FIGURE_IDS.length + 1);
  });

  it("prints no gaps where a number was missing", () => {
    expect(page).not.toContain("undefined");
    expect(page).not.toContain("NaN");
    // a value that came back empty would land as its own word in the prose
    expect(page).not.toMatch(/>\s*null|\snull[.,%]/);
  });

  it("still stands up on a build whose metros carry no forecast at all", () => {
    const bare = render([metro("10180", "Abilene, TX")]);
    expect(bare).toContain("The limits");
    expect(bare).toContain(`${points(shipped8.coverage)} of outcomes there against a nominal ${points(NOMINAL_COVERAGE)}`);
    expect(bare).not.toContain("undefined");
    expect(bare).not.toContain("NaN");
  });
});

// the counts, the panel's size and the input rules are the shipped contract's,
// read rather than typed, and the page states the rule that was chosen
describe("what the page says the model reads, and when", () => {
  const text = plain(page);

  it("counts the features and the columns riding along from the manifest", () => {
    expect(text).toContain(`${sentenceCase(inWords(INPUTS.sequence + INPUTS.annual))} features feed the models`);
    expect(text).toContain(`${inWords(INPUTS.context)} more columns ride along`);
    expect(text).not.toMatch(/Fourteen features|eight more columns/);
  });

  it("gives the panel's size and span as its manifest does", () => {
    expect(text).toContain(`${PANEL.metros} metros, ${PANEL.first} to ${PANEL.last}, ${PANEL.rows.toLocaleString("en-US")} rows`);
  });

  it("says when each annual source enters, not that every one enters with the new year", () => {
    expect(text).toContain("population and migration from the first quarter of the next year, permits from the second, income from the fourth");
    expect(text).not.toContain("known only from the first quarter of Y plus one");
    expect(text).toContain("Population growth across the 2019 to 2020 change of census base and county lines is left out");
  });

  it("says the backtest reads the expanded index only where fhfa had published it", () => {
    expect(text).toContain(`FHFA published the expanded-data index for ${EXPANDED_BEFORE} metros until its 2026Q1 report, and for all ${PANEL.metros} since`);
    expect(text).toContain(`for the other ${PANEL.metros - EXPANDED_BEFORE} both are masked at every quarter before 2026Q1`);
    expect(text).toContain("so that band is conservative");
    expect(text).toContain("measured as outcomes land");
  });

  it("keeps saying the backtest model and the shipped model differ", () => {
    expect(text).toContain("What the map draws is not the model the table above scored");
  });

  // three rules read no inputs, so a new feature cannot have improved them
  it("does not say every model improved when a feature joined", () => {
    expect(text).not.toMatch(/Every model on (?:that|this) table improved/);
    expect(text).toContain("No change, momentum and the metro mean read no inputs at all");
    expect(text).not.toContain("on the same features");
  });

  // fhfa publishes the error as a percent of the index already, and the map
  // shows fhfa's figure. the page no longer says it is fitted in index points
  it("does not say the index error is in index points", () => {
    expect(text).not.toContain("index points");
    expect(text).toContain("a percent of the index");
  });

  it("types no validation loss the retrain would leave behind", () => {
    expect(text).not.toMatch(/0\.006\d{3}/);
  });
});

// the page said "ten series" in type and went on saying it for two commits
// after the input set was cut. the count is generated now, and this is the
// guard that it stays generated rather than quietly becoming type again
describe("how many series the page says the model reads", () => {
  it("matches the shipped contract, whatever it currently is", () => {
    expect(page).toContain(`24 quarters of ${inWords(INPUTS.sequence)} series`);
    expect(page).toContain(`${inWords(INPUTS.annual)} annual features at the origin`);
  });

  it("is the count the panel manifest published, not a number someone typed", () => {
    const manifest = JSON.parse(readFileSync("../ml/results/panel_manifest.json", "utf8"));
    expect(INPUTS.sequence).toBe(manifest.features.sequence.length);
    expect(INPUTS.annual).toBe(manifest.features.annual.length);
  });
});

// what the page claims about how the model was built has to be what was done.
// each of these guards a sentence that once said more than the build did
describe("the claims the page makes about the build", () => {
  const text = plain(page);
  const fitEnd = PANEL_COVERAGE?.fitEnd ?? FIT_END;
  const unseen = PANEL_COVERAGE?.unseen ?? [];

  // fhfa revises past quarters with later sales, and population and income
  // are later vintages, so the panel does not hold what was known at the time
  it("does not say nothing leaks, and names what the panel cannot undo", () => {
    expect(text).not.toContain("Nothing leaks");
    expect(text).toContain("A value enters the panel when it was published.");
    expect(text).toContain(`Three things the panel cannot undo. FHFA revises past quarters as later sales come in, so every origin reads the vintage of the index that runs through ${PANEL.last}, not the one published at the time.`);
    expect(text).toContain("Population and income are later vintages too");
    expect(text).toContain("though every block reads the later vintages described under the panel");
  });

  // ridge and gradient boosting fit the whole train block, the networks only
  // its first part, and ridge reads lags and two means the networks do not
  // the extra years are a fact about the fit and stay. what they did to the
  // gap is not measured, so the page no longer says they are part of it
  it("does not say ridge reads the same inputs as the gru, and says how much longer it fits", () => {
    const years = inWords(Number(TRAIN_END.slice(0, 4)) - Number(fitEnd.slice(0, 4)));
    expect(text).not.toContain("same inputs");
    expect(text).toContain(`So the classical rules learn from ${years} more years than the networks`);
    expect(text).toContain("plus lags of the metro's quarterly price growth, its running mean and a national growth mean");
    expect(text).not.toContain("part of that edge");
    if (unseen.length > 0) expect(text).toContain("so the two networks in the backtest below read");
  });

  // the calibration block also picks the network that ships, and the run that
  // admitted permits and income fits into it and scores the rest of it
  it("does not say the calibration block sets the band width and nothing else", () => {
    expect(text).not.toContain("band width only");
    expect(text).not.toContain("validation loss alone");
    expect(page).toContain("<td>band width, which of the two networks ships, and the run that admitted permits and income</td>");
  });

  // at the first test origin no metro has fifty years of price history
  it("calls the metro mean the long run average, not a fifty year one", () => {
    expect(text).not.toMatch(/fifty year/i);
    expect(text).toContain("against the metro's own long run average");
    expect(text).toMatch(/beats the metro's own long run average|does not beat the metro's own long run average/);
  });

  // both collectors start in 2014 because that is where they were written to
  // start, and nothing in the repo says the data is not published earlier
  it("gives no reason permits and income were not pulled back further", () => {
    expect(text).not.toContain("does not exist earlier");
    if (unseen.length > 0) {
      expect(text).toContain(`${sentenceCase(joinList(unseen.map(featureName)))} ${unseen.length === 1 ? "has" : "have"} not been.`);
    }
  });
});

// the input rule the page states is the one the shipped set was chosen by. the
// page types no loss, so these read the admission run behind its words: a
// rerun that changes who beats whom fails here before the page can say it
describe("the input rule the page states", () => {
  const text = plain(page);
  const arms = (file: string) => {
    const out = new Map<string, Map<string, number>>();
    for (const line of readFileSync(file, "utf8").trim().split("\n").slice(1)) {
      const cells = /^"([^"]*)",\d+,(\d+),([^,]+),/.exec(line);
      if (!cells) continue;
      if (!out.has(cells[1])) out.set(cells[1], new Map());
      out.get(cells[1])!.set(cells[2], Number(cells[3]));
    }
    return out;
  };
  const base = arms("../ml/results/admission.csv");
  const pairs = arms("../ml/results/admission_pairs.csv");
  const manifest = JSON.parse(readFileSync("../ml/results/panel_manifest.json", "utf8"));
  const nine = [...base.entries()].find(([arm]) => arm.startsWith("nine"))?.[1];
  // lower validation loss than the nine on every seed the nine ran
  const beatsNine = (seeds: Map<string, number> | undefined) =>
    !!nine && !!seeds && [...nine.entries()].every(([seed, loss]) => (seeds.get(seed) ?? Infinity) < loss);

  it("no longer says a margin inside the seed spread keeps the simpler set", () => {
    expect(text).not.toContain("is a coin");
    expect(text).not.toContain("the simpler set stays");
    expect(text).toContain("is not read as a result either way");
    expect(text).toContain("compares sets seed for seed");
  });

  it("says permits and income ship because they beat the set without them on every seed", () => {
    expect(beatsNine(pairs.get("eleven, without zori and listings"))).toBe(true);
    expect(manifest.features.annual).toEqual(expect.arrayContaining(["permits_per_1000", "income_growth"]));
    expect(text).toContain("Permits and income beat the set without them on every seed, and ship.");
  });

  // added to the set that ships, rents and listing prices move the loss less
  // than one set's own seeds do, so they stay out, and the page says why
  it("keeps rents and listing prices out because added to the shipped set they gain less than the seeds spread", () => {
    const all = [...base.entries()].find(([arm]) => arm.startsWith("thirteen"))?.[1];
    const shipped = pairs.get("eleven, without zori and listings");
    expect(all && shipped, "the admission run has no thirteen arm or no shipped eleven").toBeTruthy();
    const seeds = [...shipped!.keys()].filter((seed) => all!.has(seed));
    const mean = (by: Map<string, number>) => seeds.reduce((sum, seed) => sum + by.get(seed)!, 0) / seeds.length;
    const spread = (by: Map<string, number>) => Math.max(...by.values()) - Math.min(...by.values());
    const wins = seeds.filter((seed) => all!.get(seed)! < shipped!.get(seed)!).length;
    expect(mean(shipped!) - mean(all!)).toBeLessThan(Math.max(spread(all!), spread(shipped!)));
    expect(beatsNine(pairs.get("eleven, without permits and income"))).toBe(true);
    expect(manifest.context).toEqual(expect.arrayContaining(["zori_yoy", "listing_price_yoy"]));
    expect(text).toContain("Rents and listing prices beat the set without them on every seed as well, but added to the shipped set "
      + `they lower the validation loss by less than the spread across one set's seeds, winning on ${inWords(wins)} of `
      + `${inWords(seeds.length)} seeds, so they stay out.`);
    expect(text).not.toContain("the next thing to decide");
  });
});

// a lower error on the table can be luck. the paired test says which gaps are
// not, and the page's sentences about ridge, the long run average and the
// table as a whole are chosen by its p values. each of these also moves a p
// value in place, the way a retrain would, and reads the page again
describe("what the paired test lets the page say", () => {
  const read = () => plain(render(METROS));
  const text = read();
  const LEVEL = 0.05;
  const tested = (against: string) => PAIRED.filter((r) => r.against === against && Number.isFinite(r.pValue));
  const apart = (against: string) => tested(against).filter((r) => r.pValue < LEVEL).map((r) => r.horizon);
  const span = (against: string) => {
    const ps = tested(against).map((r) => r.pValue);
    return `p ${Math.min(...ps).toFixed(2)} to ${Math.max(...ps).toFixed(2)}`;
  };
  // sets one row's p value for the length of a check, then puts it back
  function moved(against: string, horizon: number, pValue: number, check: (page: string) => void) {
    const row = PAIRED.find((r) => r.against === against && r.horizon === horizon)!;
    const was = row.pValue;
    row.pValue = pValue;
    try {
      check(read());
    } finally {
      row.pValue = was;
    }
  }

  it("says what the test is and why it averages over metros at each origin", () => {
    const origins = [...new Set(PAIRED.map((r) => r.origins))];
    expect(text).toContain("A lower mean error can be luck, so the GRU is also tested against every other model on the table");
    expect(text).toContain("Metros at one origin share its shocks, so they are not independent draws: the gap between two errors "
      + "is averaged across metros at each origin first");
    if (origins.length === 1) expect(text).toContain(`asks whether its mean over the ${origins[0]} origins is far enough from zero`);
  });

  it("names every comparison the test separates from chance, and says it separates nothing else", () => {
    const found = modelsIn(BACKTEST).filter((m) => m !== SHIPPED && apart(m).length > 0);
    for (const m of found) expect(text).toContain(`from ${proseName(m)} at ${horizonPhrase(apart(m))}`);
    for (const m of modelsIn(BACKTEST).filter((x) => x !== SHIPPED && !found.includes(x))) {
      expect(text).not.toContain(`separates the GRU from ${proseName(m)} at`);
      expect(text).not.toContain(`and from ${proseName(m)} at`);
    }
    expect(text).toContain(found.length > 0 ? "and it separates nothing else." : "it separates no gap on the table from chance.");
    // were the window MLP's gaps chance too, the sentence would stop naming it
    const window = apart("windowmlp");
    if (window.length === 0) return;
    const rows = PAIRED.filter((r) => r.against === "windowmlp" && window.includes(r.horizon));
    const was = rows.map((r) => r.pValue);
    rows.forEach((r) => { r.pValue = 0.5; });
    try {
      expect(read()).not.toContain("from the window MLP at");
    } finally {
      rows.forEach((r, i) => { r.pValue = was[i]; });
    }
  });

  it("calls ridge and the gru tied only while the test puts every gap between them down to chance", () => {
    const tie = tested("ridge").length === horizonsIn(BACKTEST).length && apart("ridge").length === 0;
    const sentence = `The paired test above puts every gap between ridge and the GRU down to chance, ${span("ridge")}, so the two are `
      + "tied, and the GRU ships because the pipeline picks between the two networks, not against ridge.";
    expect(text.includes(sentence)).toBe(tie);
    if (!tie) return;
    // a retrain that put ridge's two quarter gap past chance
    moved("ridge", 2, 0.01, (after) => {
      expect(after).not.toContain("so the two are tied");
      expect(after).toContain("the paired test above separates ridge from the GRU at two quarters");
    });
  });

  // the limits entry says the gru loses every horizon on the mean error. while
  // the test calls each of those gaps chance it gives the same verdict there,
  // and only a gap past chance leaves the pipeline as the one reason it ships
  it("gives the limits entry the same verdict on ridge", () => {
    const mae = (model: string, h: number) => BACKTEST.find((r) => r.model === model && r.horizon === h)?.maePct;
    const ahead = horizonsIn(BACKTEST).every((h) => (mae("ridge", h) ?? Infinity) < (mae(SHIPPED, h) ?? -Infinity));
    const tie = tested("ridge").length === horizonsIn(BACKTEST).length && apart("ridge").length === 0;
    if (!ahead) return;
    expect(text).toContain("It loses every horizon.");
    expect(text.includes("The GRU is on the map only because")).toBe(!tie);
    if (!tie) return;
    moved("ridge", 2, 0.01, (after) => {
      expect(after).toContain("The GRU is on the map only because the pipeline picks between the two networks, not against ridge.");
    });
  });

  it("says no gap against the long run average passes the test only while none does", () => {
    const none = tested(LONG_RUN).length > 0 && apart(LONG_RUN).length === 0;
    expect(text.includes(`No gap between the GRU and that average passes the paired test above, ${span(LONG_RUN)}.`)).toBe(none);
    if (!none) return;
    moved(LONG_RUN, 8, 0.01, (after) => {
      expect(after).not.toContain("No gap between the GRU and that average passes");
      expect(after).toContain("The paired test above separates the GRU from that average at eight quarters");
    });
  });

  // the coverage figure is drawn from the whole panel, and the backtest reads
  // the expanded index and its error only where fhfa had published them
  it("says the coverage figure draws the expanded index fuller than the backtest reads it", () => {
    expect(text).toContain(`The expanded index and the index error are drawn for all ${PANEL.metros} metros on either side of the `
      + `rule, as FHFA publishes them now, while the backtest reads them only for the ${EXPANDED_BEFORE} FHFA published them for `
      + `before its ${EXPANDED_FOR_ALL_FROM} report.`);
  });
});

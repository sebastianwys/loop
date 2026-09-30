import { describe, expect, it } from "vitest";
import { EXPANDED_BEFORE, EXPANDED_FOR_ALL_FROM, type BacktestRow, type ForecastFacts } from "./model";
import {
  FIGURES, FIGURE_FILES, FIGURE_IDS, calibrationFigure, comparisonFigure, coverageFigure, designFigure, distributionFigure,
  fansFigure, figureSrc, said, trainingFigure,
} from "./modelFigures";
import { FORECAST, PANEL } from "./modelNumbers";

const row = (model: string, horizon: number, maePct: number, coverage = 0.8): BacktestRow =>
  ({ model, horizon, maePct, coverage, width: 0.1, n: 100 });

const ASCII = /^[\x20-\x7e]*$/;

describe("the figures the model page ships", () => {
  it("names a png the build copies, once each", () => {
    expect(FIGURE_FILES).toHaveLength(FIGURE_IDS.length);
    expect(new Set(FIGURE_FILES).size).toBe(FIGURE_FILES.length);
    for (const file of FIGURE_FILES) expect(file).toMatch(/^\d{2}_[a-z_]+\.png$/);
  });

  it("points at the folder the build copies into, not at the ml folder", () => {
    for (const id of FIGURE_IDS) {
      expect(figureSrc(FIGURES[id])).toBe(`/figures/${FIGURES[id].file}`);
    }
  });

  // alt text that says "chart" tells a reader who cannot see it nothing at
  // all, and these figures are the argument rather than decoration
  it("describes what every figure shows rather than that it is a chart", () => {
    for (const id of FIGURE_IDS) {
      const { alt } = FIGURES[id];
      expect(alt.length, id).toBeGreaterThan(120);
      expect(alt.toLowerCase(), id).not.toMatch(/^(a )?(chart|graph|figure|image|plot)\b/);
      expect(alt.trim(), id).toBe(alt);
    }
  });

  it("gives every figure a caption that says why it is on the page", () => {
    for (const id of FIGURE_IDS) {
      expect(FIGURES[id].caption.length, id).toBeGreaterThan(40);
    }
  });

  // without both, the paragraph under a figure jumps when the png arrives
  it("declares a pixel size for every figure so the column does not reflow", () => {
    for (const id of FIGURE_IDS) {
      const { width, height } = FIGURES[id];
      expect(Number.isInteger(width) && width > 0, id).toBe(true);
      expect(Number.isInteger(height) && height > 0, id).toBe(true);
    }
  });

  it("is ascii, like every other tracked file here", () => {
    for (const id of FIGURE_IDS) {
      const figure = FIGURES[id];
      expect(ASCII.test(figure.alt), `${id} alt`).toBe(true);
      expect(ASCII.test(figure.caption), `${id} caption`).toBe(true);
    }
  });
});

// every number and every comparison in the figure text is read off the data,
// so a retrain that redraws a png moves its description with it
describe("the words a figure is given, chosen by its numbers", () => {
  it("says the strongest three converge at the long end only when they do", () => {
    const apart = (far: number) => [
      row("a", 1, 1.0), row("b", 1, 1.3), row("c", 1, 1.6), row("d", 1, 3.0),
      row("a", 8, 9.0), row("b", 8, 9.0 + far / 2), row("c", 8, 9.0 + far), row("d", 8, 15.0),
    ];
    expect(comparisonFigure(apart(0.2)).caption).toContain("converge at the long end");
    expect(comparisonFigure(apart(1.0)).caption).toContain("furthest apart at the long end");
    expect(comparisonFigure(apart(1.0)).caption).not.toContain("converge");
    expect(comparisonFigure(apart(1.0)).alt).toContain("between 9.0 and 10.0");
  });

  it("says every model's error rises only when every one does", () => {
    const rows = [row("a", 1, 1), row("a", 8, 2), row("b", 1, 3), row("b", 8, 2)];
    expect(comparisonFigure(rows).alt).toContain("one of them rising at every step");
    expect(comparisonFigure(rows).caption).toContain("for one of the two models");
  });

  it("says the band holds where it reaches nominal and falls short where it does not", () => {
    const short = calibrationFigure([row("seqgru", 1, 1, 0.8), row("seqgru", 8, 9, 0.66)], []);
    expect(short.caption).toContain("falls short of its nominal 0.90 at every horizon, furthest at eight quarters, 0.66");
    const mixed = calibrationFigure([row("seqgru", 1, 1, 0.92), row("seqgru", 8, 9, 0.66)], []);
    expect(mixed.caption).toContain("reaches its nominal 0.90 at one quarter and falls short at eight quarters");
    expect(mixed.caption).not.toMatch(/hold at short/);
  });

  it("names where the raw band sits closest to and furthest from what it claims", () => {
    const figure = calibrationFigure([row("seqgru", 1, 1, 0.8)], [{ horizon: 1, coverage: 0.59 }, { horizon: 4, coverage: 0.69 }]);
    expect(figure.alt).toContain("closest at four quarters and furthest off at one quarter");
  });

  it("says no bar sits below zero only when no metro is forecast to fall", () => {
    const none: ForecastFacts = { ...FORECAST, falling: 0 };
    expect(distributionFigure(none).alt).toContain("No bar sits below zero.");
    expect(distributionFigure({ ...FORECAST, falling: 5 }).alt).toContain("Five of the");
    expect(distributionFigure({ ...FORECAST, falling: 5 }).alt).not.toContain("No bar sits below zero");
  });

  it("gives the fans' far bands as the forecast has them", () => {
    const fans = fansFigure({ ...FORECAST, fans: [{ cbsa: "16984", median: 13.12, lo: -5.49, hi: 38.7 }] });
    expect(fans.alt).toContain(`the Chicago division's eight quarter band runs from ${said(-5.49)} percent to ${said(38.7)} percent around a median of ${said(13.12)}`.replace("the", "The"));
  });

  it("tells a network that settled early from one that stopped at its low", () => {
    const text = trainingFigure([
      { model: "windowmlp", stop: 2, last: 7, flatFrom: null, trainFalls: true },
      { model: "seqgru", stop: 12, last: 17, flatFrom: 3, trainFalls: false },
    ]).alt;
    expect(text).toContain("The window MLP stops at epoch 2");
    expect(text).toContain("keeps falling through epoch 7");
    expect(text).toContain("within one percent of that low from epoch 3");
  });

  // the blocks row is dated by outcome, so its rule sits where validation
  // starts. a row of origins crosses that edge as many quarters earlier as it
  // looks ahead, and the figure draws each row's mark there
  it("puts each horizon's mark just before its first validation origin", () => {
    const { alt, caption } = designFigure("2014Q4", [1, 2, 4, 8]);
    expect(alt).toContain("On the blocks row a dashed rule at the start of 2015 splits the train block");
    expect(alt).toContain("just before its first validation origin: 2014Q4 at one quarter, 2014Q3 at two, 2014Q1 at four and 2013Q1 at eight.");
    expect(alt).not.toContain("A dashed line at the start of 2015");
    expect(caption).toContain("each row's dashed mark steps left with it");
    const later = designFigure("2015Q2", [1, 4]).alt;
    expect(later).toContain("a dashed rule at 2015Q3 splits");
    expect(later).toContain("just before its first validation origin: 2015Q2 at one quarter and 2014Q3 at four.");
  });

  // the figure is drawn from the whole panel, which carries the expanded index
  // and its error for every metro fhfa publishes them for now. the backtest
  // reads them only where fhfa had published them at the time
  it("says the expanded index and its error are drawn fuller than the backtest reads them", () => {
    const coverage = {
      fitEnd: "2014Q4", first: 1975, last: 2026, features: 11, unseen: [],
      series: [
        { label: "hpi", first: 1975, emptyBeforeFit: false },
        { label: "expanded hpi", first: 1991, emptyBeforeFit: false },
        { label: "index error", first: 1991, emptyBeforeFit: false },
      ],
    };
    const { alt, caption } = coverageFigure(coverage, PANEL);
    const fuller = `The expanded index and the index error are drawn for all ${PANEL.metros} metros on either side of the rule, as FHFA `
      + `publishes them now, while the backtest reads them only for the ${EXPANDED_BEFORE} FHFA published them for before its `
      + `${EXPANDED_FOR_ALL_FROM} report.`;
    expect(caption).toContain(fuller);
    expect(alt).toContain(fuller);
    // the count of empty series still sits right after the first sentence, so its "it" is still the rule
    expect(caption).toMatch(/^Everything right of the rule is coverage the model is scored on and never taught\. Every series has something on the left of it\./);
    const error = coverageFigure({ ...coverage, series: coverage.series.filter((s) => s.label !== "expanded hpi") }, PANEL).caption;
    expect(error).toContain("The index error is drawn for all");
    expect(coverageFigure({ ...coverage, series: coverage.series.slice(0, 1) }, PANEL).caption).not.toContain("backtest reads");
  });

  it("counts the series empty left of the rule, and says nothing it cannot read", () => {
    const coverage = {
      fitEnd: "2014Q4", first: 1975, last: 2026, features: 11, unseen: [],
      series: [{ label: "hpi", first: 1975, emptyBeforeFit: false }, { label: "income", first: 2016, emptyBeforeFit: true }],
    };
    expect(coverageFigure(coverage, PANEL).caption).toContain("One series has nothing at all on the left of it.");
    expect(coverageFigure(coverage, PANEL).alt).toContain("Income is empty everywhere left of the rule.");
    expect(coverageFigure(null, PANEL).caption).not.toMatch(/series ha/);
  });
});

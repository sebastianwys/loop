// the figures the model page shows, with the size each png really is so the
// column does not jump as they arrive, and alt text that says what the figure
// shows rather than that it is a chart.
//
// scripts/model-assets.mjs copies exactly these out of ml/results/figures at
// build time, and its test fails if the two lists drift apart. the other six
// figures the ml folder renders describe the panel or repeat a chart that is
// already here, so they are not worth the megabytes.
//
// the same script compiles the numbers these figures are drawn from into
// modelNumbers.ts, and every number and every comparison in the alt text and
// the captions below is read from there. a retrain redraws the pngs, and the
// words describing them move with it instead of describing the old ones
import {
  EXPANDED_BEFORE, EXPANDED_FOR_ALL_FROM, FIT_END, NOMINAL_COVERAGE, SHIPPED, TRAIN_END, horizonPhrase, horizonWord, horizonsIn,
  inWords, points, proseName, rowAt, scored, sentenceCase, shiftQuarter,
} from "./model";
import type { BacktestRow, ForecastFacts, PanelCoverage, PanelFacts, RawBand, TrainingFacts } from "./model";
import { BACKTEST, FORECAST, PANEL, PANEL_COVERAGE, RAW_BAND, TRAINING } from "./modelNumbers";

export type FigureId =
  | "coverage" | "design" | "training" | "comparison" | "calibration" | "fans" | "distribution";

export interface ModelFigure {
  file: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
}

// a signed percent the way the alt text says one aloud: "plus 3.8"
export const said = (value: number): string => `${value < 0 ? "minus" : "plus"} ${Math.abs(value).toFixed(1)}`;

// "a, b and c"
function list(items: string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// the rows of the coverage figure, as the prose names them
const SERIES_NAMES: Record<string, string> = {
  hpi: "house prices",
  "expanded hpi": "the expanded index",
  "index error": "the index error",
  "national macro": "national macro",
  unemp: "unemployment",
  mortgage: "the mortgage rate",
  zhvi: "Zillow home values",
  zori: "rents",
  permits: "permits",
  population: "population",
  income: "income",
  listings: "listings",
  inventory: "inventory",
};

const seriesName = (label: string) => SERIES_NAMES[label] ?? label;

// the series that have nothing at all left of the rule the model fits up to
export function emptyBeforeFit(coverage: PanelCoverage | null): string[] {
  return coverage ? coverage.series.filter((s) => s.emptyBeforeFit).map((s) => seriesName(s.label)) : [];
}

// the rows the figure draws from the panel as fhfa publishes them now, which
// the backtest reads only where fhfa had published them at the time
const REALTIME_ROWS = ["expanded hpi", "index error"];

// the figure is drawn from the whole panel, so for those rows it shows more
// than the backtest ever reads, on both sides of the rule
function drawnFuller(coverage: PanelCoverage, panel: PanelFacts): string {
  const rows = coverage.series.filter((s) => REALTIME_ROWS.includes(s.label)).map((s) => seriesName(s.label));
  if (rows.length === 0) return "";
  const them = rows.length === 1 ? "it" : "them";
  return `${sentenceCase(list(rows))} ${rows.length === 1 ? "is" : "are"} drawn for all ${panel.metros} metros on either side of the rule,`
    + ` as FHFA publishes ${them} now, while the backtest reads ${them} only for the ${EXPANDED_BEFORE} FHFA published ${them} for`
    + ` before its ${EXPANDED_FOR_ALL_FROM} report.`;
}

export function coverageFigure(coverage: PanelCoverage | null, panel: PanelFacts): Pick<ModelFigure, "alt" | "caption"> {
  const lead = "Everything right of the rule is coverage the model is scored on and never taught.";
  if (!coverage) {
    return {
      alt: `A grid of the panel's source series against the years ${panel.first.slice(0, 4)} to ${panel.last.slice(0, 4)}, each cell `
        + `shaded by the share of the ${panel.metros} metros that have a value, with a vertical rule at the last year the model fits on.`,
      caption: lead,
    };
  }
  const fitYear = coverage.fitEnd.slice(0, 4);
  // the series grouped by the year they start, earliest first
  const starts = new Map<number, string[]>();
  for (const s of coverage.series) {
    if (s.first === null) continue;
    starts.set(s.first, [...(starts.get(s.first) ?? []), seriesName(s.label)]);
  }
  const years = [...starts.keys()].sort((a, b) => a - b);
  const startSentence = years.length === 0 ? "" : ` ${sentenceCase(list(years.map((year, i) =>
    `${list(starts.get(year)!)}${i === 0 ? ` start${starts.get(year)!.length === 1 ? "s" : ""}` : ""} in ${year}`)))}.`;
  const empty = emptyBeforeFit(coverage);
  const emptySentence = empty.length === 0
    ? " Every series has something left of the rule."
    : ` ${sentenceCase(list(empty))} ${empty.length === 1 ? "is" : "are"} empty everywhere left of the rule.`;
  const count = empty.length === 0
    ? "Every series has something on the left of it."
    : `${sentenceCase(inWords(empty.length))} ${empty.length === 1 ? "series has" : "series have"} nothing at all on the left of it.`;
  const fuller = drawnFuller(coverage, panel);
  return {
    alt: `A grid of ${inWords(coverage.series.length)} source series against the years ${coverage.first} to ${coverage.last}, each cell `
      + `shaded by the share of the ${panel.metros} metros that have a value, with a vertical rule at the end of ${fitYear} marked `
      + `as the last year the model fits on.${startSentence}${emptySentence}${fuller ? ` ${fuller}` : ""}`,
    caption: `${lead} ${count}${fuller ? ` ${fuller}` : ""}`,
  };
}

// the split figure. its blocks row is dated by outcome, so the rule there sits
// where validation starts. a row of origins crosses that edge as many quarters
// earlier as it looks ahead, so each horizon row has its own mark, just before
// the first origin whose outcome lands in validation
export function designFigure(fitEnd: string, horizons: number[]): Pick<ModelFigure, "alt" | "caption"> {
  const start = shiftQuarter(fitEnd, 1);
  const rule = start === null ? "where validation starts" : start.endsWith("Q1") ? `at the start of ${start.slice(0, 4)}` : `at ${start}`;
  const firsts = start === null ? [] : horizons.map((h) => ({ h, first: shiftQuarter(start, -h) }));
  const marks = firsts.every((m) => m.first !== null) && firsts.length > 0
    ? `: ${list(firsts.map((m, i) => `${m.first} at ${i === 0 ? horizonPhrase([m.h]) : horizonWord(m.h)}`))}`
    : "";
  return {
    alt: `A row of the three blocks, dated by outcome, above ${inWords(horizons.length)} rows, one per horizon, with a tick at`
      + ` every forecast origin. Ticks are coloured by the block the outcome falls in: train through ${TRAIN_END}, calibration`
      + ` through 2021Q4, test from 2022Q1. On the blocks row a dashed rule ${rule} splits the train block into the part the`
      + " model fits on and the part held back for validation. Each horizon row has its own short dashed mark, as many quarters"
      + ` earlier as it looks ahead, just before its first validation origin${marks}. The longer the horizon, the earlier its`
      + " ticks change colour, and since the outcome decides the block, every origin lands in one.",
    caption: "Read down a column: the longer the horizon, the earlier an origin has to stop being something the model is"
      + " allowed to learn from, and each row's dashed mark steps left with it. Together the dashed marks draw the line that"
      + " decides what a feature can be taught at all.",
  };
}

// how a model is named mid sentence in the alt text, article and all
const prose = proseName;

export function trainingFigure(training: TrainingFacts[]): Pick<ModelFigure, "alt" | "caption"> {
  const names = training.map((t) => prose(t.model));
  const told = training.map((t, i) => {
    const stops = `${sentenceCase(names[i])} stops at epoch ${t.stop}, where its validation loss is lowest`;
    if (t.flatFrom !== null && t.flatFrom < t.stop) return `${stops}, though it is within one percent of that low from epoch ${t.flatFrom}.`;
    if (t.trainFalls && t.last > t.stop) return `${stops}, while its fitting loss keeps falling through epoch ${t.last} and validation never comes back down.`;
    return `${stops}.`;
  });
  return {
    alt: `${sentenceCase(inWords(training.length))} panels of pinball loss against epoch, ${list(names)}, each with a fitting `
      + `curve and a validation curve. ${told.join(" ")}`,
    caption: "Both networks stop on validation loss. Neither the test block nor the calibration block is consulted.",
  };
}

// the scored rows at a horizon, lowest error first
const scoredAt = (rows: BacktestRow[], horizon: number) =>
  rows.filter((r) => r.horizon === horizon && scored(r.maePct)).sort((a, b) => a.maePct - b.maePct);

// the gap from the best model to the third best at a horizon, in points
export function strongestSpread(rows: BacktestRow[], horizon: number): number | null {
  const best = scoredAt(rows, horizon).slice(0, 3);
  return best.length < 3 ? null : best[2].maePct - best[0].maePct;
}

// whether a model's error rises at every step of the horizon
function rising(rows: BacktestRow[], model: string): boolean {
  const errors = horizonsIn(rows).map((h) => rowAt(rows, model, h)?.maePct).filter(scored);
  return errors.every((e, i) => i === 0 || e > errors[i - 1]);
}

export function comparisonFigure(rows: BacktestRow[]): Pick<ModelFigure, "alt" | "caption"> {
  const horizons = horizonsIn(rows);
  const models = [...new Set(rows.map((r) => r.model))];
  const far = horizons[horizons.length - 1];
  const up = models.filter((m) => rising(rows, m)).length;
  const riseAlt = up === models.length ? "every one rising with the horizon" : `${inWords(up)} of them rising at every step of the horizon`;
  const riseCaption = up === models.length ? "Error rises with the horizon for every model" : `Error rises at every step of the horizon for ${inWords(up)} of the ${inWords(models.length)} models`;
  const at = scoredAt(rows, far);
  const strongest = at.slice(0, 3);
  const rest = at.slice(3).reverse();
  const tenth = (v: number) => v.toFixed(1);
  // worst first, down to the strongest three, which are given as the range
  // they sit in
  const worst = rest.length > 0 ? `${prose(rest[0].model)} is worst at ${tenth(rest[0].maePct)} points` : "";
  const next = rest.slice(1).map((r) => `${prose(r.model)} at ${tenth(r.maePct)}`);
  const order = next.length > 0 ? `${worst}, then ${list(next)}` : worst;
  const band = strongest.map((r) => Number(tenth(r.maePct)));
  const three = strongest.length === 3
    ? `the strongest three, ${list(strongest.map((r) => prose(r.model)))}, sit between ${Math.min(...band).toFixed(1)} and ${Math.max(...band).toFixed(1)}`
    : "";
  const ranking = [order, three].filter(Boolean).join("; ");
  const spreads = horizons.map((h) => ({ h, spread: strongestSpread(rows, h) })).filter((s): s is { h: number; spread: number } => s.spread !== null);
  const farSpread = spreads.find((s) => s.h === far);
  const shorter = spreads.filter((s) => s.h !== far);
  let apart = "";
  if (farSpread && shorter.length > 0) {
    const tightest = shorter.reduce((a, b) => (b.spread < a.spread ? b : a));
    if (shorter.every((s) => farSpread.spread < s.spread)) {
      apart = ", and the strongest three converge at the long end, where the choice between them stops being obvious";
    } else if (shorter.every((s) => farSpread.spread > s.spread)) {
      apart = `, and the strongest three sit furthest apart at the long end, ${points(farSpread.spread)} points from the first to the third against ${points(tightest.spread)} at ${horizonPhrase([tightest.h])}`;
    } else {
      apart = `, and the strongest three sit ${points(farSpread.spread)} points apart at the long end`;
    }
  }
  return {
    alt: `${sentenceCase(inWords(models.length))} lines of mean absolute error against horizon, ${horizons[0]} to ${far} quarters, ${riseAlt}. `
      + `At ${horizonPhrase([far])}${ranking ? ` ${ranking}` : " there is nothing scored"}.`,
    caption: `${riseCaption}${apart}.`,
  };
}

// a 10 to 90 band claims eight in ten of outcomes before any margin is added
const RAW_NOMINAL = 0.8;

export function calibrationFigure(rows: BacktestRow[], raw: RawBand[]): Pick<ModelFigure, "alt" | "caption"> {
  const horizons = horizonsIn(rows);
  const cover = horizons.map((h) => ({ h, value: rowAt(rows, SHIPPED, h)?.coverage })).filter((c): c is { h: number; value: number } => scored(c.value));
  const heads = cover.map((c) => points(c.value));
  const rawScored = raw.filter((r) => scored(r.coverage));
  let rawSentence = "";
  if (rawScored.length > 0) {
    const miss = (r: RawBand) => Math.abs(RAW_NOMINAL - r.coverage);
    const closest = rawScored.reduce((a, b) => (miss(b) < miss(a) ? b : a));
    const furthest = rawScored.reduce((a, b) => (miss(b) > miss(a) ? b : a));
    rawSentence = ` The raw 10 to 90 band under the margin holds ${list(rawScored.map((r) => points(r.coverage)))} of outcomes `
      + `against the ${points(RAW_NOMINAL)} it claims, closest at ${horizonPhrase([closest.horizon])} and furthest off at `
      + `${horizonPhrase([furthest.horizon])}.`;
  }
  const reached = cover.filter((c) => c.value >= NOMINAL_COVERAGE);
  const short = cover.filter((c) => c.value < NOMINAL_COVERAGE);
  const worst = cover.length > 0 ? cover.reduce((a, b) => (b.value < a.value ? b : a)) : null;
  let caption: string;
  if (cover.length === 0) {
    caption = "The band's coverage on the test block is not in this build.";
  } else if (short.length === 0) {
    caption = `The band reaches its nominal ${points(NOMINAL_COVERAGE)} at every horizon in this build.`;
  } else if (reached.length === 0) {
    caption = `This is the failure the limits below are about: the band falls short of its nominal ${points(NOMINAL_COVERAGE)} at `
      + `every horizon, furthest at ${horizonPhrase([worst!.h])}, ${points(worst!.value)}.`;
  } else {
    caption = `The band reaches its nominal ${points(NOMINAL_COVERAGE)} at ${horizonPhrase(reached.map((c) => c.h))} and falls `
      + `short at ${horizonPhrase(short.map((c) => c.h))}, furthest at ${horizonPhrase([worst!.h])}, ${points(worst!.value)}.`;
  }
  return {
    alt: `${sentenceCase(inWords(horizons.length))} panels, one per horizon, plotting the share of test outcomes below each predicted `
      + `quantile against the nominal quantile.${rawSentence} The panel headings report band coverage of ${list(heads)} against a `
      + `nominal ${points(NOMINAL_COVERAGE)}.`,
    caption,
  };
}

// the fans figure's two metros the alt text names, by code
const FAN_NAMES: Record<string, string> = { "16984": "the Chicago division", "12420": "Austin" };

export function fansFigure(forecast: ForecastFacts): Pick<ModelFigure, "alt" | "caption"> {
  const until = forecast.end ? ` to ${forecast.end.slice(0, 4)}` : "";
  const bands = forecast.fans.map((fan, i) => {
    const name = FAN_NAMES[fan.cbsa] ?? fan.cbsa;
    return i === 0
      ? `${name}'s ${horizonWord(forecast.far)} quarter band runs from ${said(fan.lo)} percent to ${said(fan.hi)} percent around a median of ${said(fan.median)}`
      : `${name}'s runs from ${said(fan.lo)} to ${said(fan.hi)} around ${said(fan.median)}`;
  });
  return {
    alt: `Eight metros, each showing its house price index since 2015 and the model's median path${until} inside a shaded 90 percent band.`
      + (bands.length > 0 ? ` ${sentenceCase(bands.join(", and "))}.` : ""),
    caption: `Eight metros at the ${forecast.origin ?? "latest"} origin: the index since 2015, the median path, and the 90 percent band drawn around it.`,
  };
}

export function distributionFigure(forecast: ForecastFacts): Pick<ModelFigure, "alt" | "caption"> {
  const peak = forecast.peak;
  const falling = forecast.falling === 0
    ? "No bar sits below zero."
    : `${sentenceCase(inWords(forecast.falling))} of the ${forecast.count} ${forecast.falling === 1 ? "metro sits" : "metros sit"} below zero, forecast to fall.`;
  return {
    alt: `A histogram of the median four quarter forecast across ${forecast.count} metros, running from ${said(forecast.lowest)} percent `
      + `to ${said(forecast.highest)} percent, its tallest bar ${peak.count} metros between ${said(peak.from)} and ${said(peak.to)} percent, `
      + `with marked lines at the 10th percentile of ${said(forecast.p10)} percent, the median of ${said(forecast.median)} and the 90th `
      + `percentile of ${said(forecast.p90)}. ${falling}`,
    caption: "The shipped four quarter forecast across every metro on the map.",
  };
}

export const FIGURES: Record<FigureId, ModelFigure> = {
  coverage: {
    file: "01_coverage.png",
    width: 1873,
    height: 994,
    ...coverageFigure(PANEL_COVERAGE, PANEL),
  },
  design: {
    file: "05_backtest_design.png",
    width: 2139,
    height: 780,
    ...designFigure(PANEL_COVERAGE?.fitEnd ?? FIT_END, horizonsIn(BACKTEST)),
  },
  training: {
    file: "09_training_curves.png",
    width: 1520,
    height: 794,
    ...trainingFigure(TRAINING),
  },
  comparison: {
    file: "12_model_comparison.png",
    width: 1394,
    height: 936,
    ...comparisonFigure(BACKTEST),
  },
  calibration: {
    file: "10_quantile_calibration.png",
    width: 1846,
    height: 1219,
    ...calibrationFigure(BACKTEST, RAW_BAND),
  },
  fans: {
    file: "11_forecast_fans.png",
    width: 2089,
    height: 1120,
    ...fansFigure(FORECAST),
  },
  distribution: {
    file: "13_forecast_distribution.png",
    width: 1377,
    height: 936,
    ...distributionFigure(FORECAST),
  },
};

export const FIGURE_IDS = Object.keys(FIGURES) as FigureId[];

export const FIGURE_FILES = FIGURE_IDS.map((id) => FIGURES[id].file);

// the path the build copies them to. public/figures is gitignored, so a tree
// that has never been built has captions and no images
export function figureSrc(figure: ModelFigure): string {
  return `/figures/${figure.file}`;
}

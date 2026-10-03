import { dateAt, fieldAt, num } from "./metrics";
import type { Metro, YearValues } from "../types";

// one published row of the backtest: a model at a horizon, scored once on the
// test block. maePct is the mean absolute error of the median forecast in
// percentage points of growth, coverage the share of outcomes inside the
// 90 percent band, width the mean band width in log growth units
export interface BacktestRow {
  model: string;
  horizon: number;
  maePct: number;
  coverage: number;
  width: number;
  n: number;
}

// the rest of what scripts/model-assets.mjs compiles out of ml/results, so the
// figures' alt text and the page's prose read numbers rather than carry them.
//
// the shipped model's raw 10 to 90 band on the test block, before the margin
export interface RawBand {
  horizon: number;
  coverage: number;
}

// a network's training history: the epoch validation loss was lowest, where
// training stopped, the last epoch run, the epoch from which validation stays
// within one percent of that low, null when it does not settle there, and
// whether the fitting loss kept falling after the low
export interface TrainingFacts {
  model: string;
  stop: number;
  last: number;
  flatFrom: number | null;
  trainFalls: boolean;
}

// one metro's far band in the fans figure, percent
export interface FanFacts {
  cbsa: string;
  median: number;
  lo: number;
  hi: number;
}

// the shipped forecast as forecasts.csv has it: the median four quarter call
// across every metro, the tallest bar of the figure's thirty, and the fans
export interface ForecastFacts {
  origin: string | null;
  end: string | null;
  far: number;
  count: number;
  p10: number;
  median: number;
  p90: number;
  lowest: number;
  highest: number;
  falling: number;
  peak: { from: number; to: number; count: number };
  fans: FanFacts[];
}

// the panel's size and span, from its manifest
export interface PanelFacts {
  rows: number;
  metros: number;
  first: string;
  last: string;
}

// what the coverage figure shows: each row's first year with a value, and
// whether it has nothing at all left of the rule the model fits up to. unseen
// is the features the backtest's fitting block never observes
export interface PanelCoverage {
  fitEnd: string;
  first: number;
  last: number;
  series: { label: string; first: number | null; emptyBeforeFit: boolean }[];
  features: number | null;
  unseen: string[];
}

// the paired test of the shipped model against one other model at one
// horizon, over the test block's origins. difference is the shipped model's
// mean error less the other's, in percentage points, so a negative one has
// the shipped model closer. pValue is NaN where the test could not be run
export interface PairedRow {
  against: string;
  horizon: number;
  origins: number;
  difference: number;
  pValue: number;
}

// one arm and seed of the admission run, and the validation loss it reached
export interface AdmissionRow {
  arm: string;
  seed: number;
  loss: number;
}

// one row of the yearly refit record: a model at a horizon, scored over one
// span of outcomes with its band set one way. span is the first outcome
// quarter scored. band is online, the band a forecaster
// could have run through the record, or static, set once on the fixed split's
// calibration block. intervalScore is the band's mean interval score, its
// width plus a penalty for every outcome that lands outside it
export interface WalkRow extends BacktestRow {
  span: string;
  band: string;
  origins: number;
  intervalScore: number;
}

// the online band's settings for one model and horizon: gamma, the step its
// aimed miss rate moves by, the trailing window of outcomes in quarters, 0
// for all of them, and whether each metro's score is scaled by its own
// volatility, null where the run did not say
export interface WalkBand {
  model: string;
  horizon: number;
  gamma: number;
  window: number;
  scaled: boolean | null;
}

// the paired test of the shipped model against one other model at one
// horizon, over one span of the yearly refit record
export interface WalkPairedRow extends PairedRow {
  span: string;
}

// the model that ships to the map, and the two it is read against: the rule
// that says nothing changes, and the metro's own long run average
export const SHIPPED = "seqgru";
export const NO_CHANGE = "no_change";
export const LONG_RUN = "metro_mean";
export const NOMINAL_COVERAGE = 0.9;

// the block design, spec.FIT_END and spec.TRAIN_END in the ml folder. these
// are settled, not results, and the page reads the fit end off the panel's
// own coverage when it has it
export const FIT_END = "2014Q4";
export const TRAIN_END = "2017Q4";

// "2014Q4" as a count of quarters, or null for anything that is not a quarter
function quarterSlot(quarter: string): number | null {
  const match = /^(\d{4})Q([1-4])$/.exec(quarter);
  return match ? Number(match[1]) * 4 + Number(match[2]) - 1 : null;
}

// "2014Q4" moved on by a count of quarters, back for a negative count
export function shiftQuarter(quarter: string, count: number): string | null {
  const at = quarterSlot(quarter);
  if (at === null) return null;
  const slot = at + count;
  return `${Math.floor(slot / 4)}Q${(slot % 4) + 1}`;
}

// how much more of the train block ridge and gradient boosting fit on than the
// two networks, which stop at the fit end and hold the rest back to choose
// their epochs: "three more years"
export function extraFit(fitEnd: string, trainEnd: string = TRAIN_END): string | null {
  const from = quarterSlot(fitEnd);
  const to = quarterSlot(trainEnd);
  if (from === null || to === null || to <= from) return null;
  const quarters = to - from;
  const [count, unit] = quarters % 4 === 0 ? [quarters / 4, "year"] : [quarters, "quarter"];
  return `${inWords(count)} more ${unit}${count === 1 ? "" : "s"}`;
}

// reading order for the table: the classical rules first, weakest to
// strongest, then the two networks. a model the csvs add later still shows,
// after these, rather than disappearing from the page
const ORDER = [NO_CHANGE, "momentum", LONG_RUN, "ridge", "gbm", "windowmlp", SHIPPED];

const LABELS: Record<string, string> = {
  no_change: "no change",
  momentum: "momentum",
  metro_mean: "metro mean",
  ridge: "ridge",
  gbm: "gradient boosting",
  windowmlp: "window MLP",
  seqgru: "sequence GRU",
  ensemble: "GRU and ridge averaged",
};

export function modelLabel(model: string): string {
  return LABELS[model] ?? model;
}

// how a model is named mid sentence, article and all
const PROSE: Record<string, string> = {
  no_change: "no change",
  momentum: "momentum",
  metro_mean: "the metro mean",
  ridge: "ridge",
  gbm: "gradient boosting",
  windowmlp: "the window MLP",
  seqgru: "the sequence GRU",
  ensemble: "the average",
};

export const proseName = (model: string): string => PROSE[model] ?? modelLabel(model);

export function rowAt(rows: BacktestRow[], model: string, horizon: number): BacktestRow | null {
  return rows.find((row) => row.model === model && row.horizon === horizon) ?? null;
}

// the horizons the csvs actually carry, so the table's columns follow the
// backtest rather than a list written here
export function horizonsIn(rows: BacktestRow[]): number[] {
  return [...new Set(rows.map((row) => row.horizon))].sort((a, b) => a - b);
}

export function modelsIn(rows: BacktestRow[]): string[] {
  return inOrder(rows.map((row) => row.model));
}

// model names in the table's reading order, any the order does not know last
function inOrder(names: string[]): string[] {
  const present = new Set(names);
  const known = ORDER.filter((model) => present.has(model));
  const rest = [...present].filter((model) => !ORDER.includes(model)).sort();
  return [...known, ...rest];
}

export interface LeaderboardRow {
  model: string;
  label: string;
  shipped: boolean;
  cells: (BacktestRow | null)[];
}

export function leaderboard(rows: BacktestRow[]): LeaderboardRow[] {
  const horizons = horizonsIn(rows);
  return modelsIn(rows).map((model) => ({
    model,
    label: modelLabel(model),
    shipped: model === SHIPPED,
    cells: horizons.map((horizon) => rowAt(rows, model, horizon)),
  }));
}

// a metric the backtest could not score reaches the page as null or NaN. it
// is missing: it never wins, never loses, never sets a gap and never counts
// as under or over the nominal coverage. read as a number it would be a zero
export function scored(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// the rows at a horizon that carry this metric, lowest first
function scoredAt(rows: BacktestRow[], horizon: number, key: "maePct" | "coverage"): BacktestRow[] {
  return rows.filter((row) => row.horizon === horizon && scored(row[key])).sort((a, b) => a[key] - b[key]);
}

// the lowest error at a horizon and how far back the next model is. a tie
// leaves the margin at zero rather than picking a winner by row order
export interface Standing {
  model: string;
  maePct: number;
  runnerUp: string | null;
  margin: number | null;
}

export function bestAt(rows: BacktestRow[], horizon: number): Standing | null {
  const at = scoredAt(rows, horizon, "maePct");
  if (at.length === 0) return null;
  const [first, second] = at;
  return {
    model: first.model,
    maePct: first.maePct,
    runnerUp: second ? second.model : null,
    margin: second ? round(second.maePct - first.maePct, 4) : null,
  };
}

// the nearest model to this one at a horizon, whichever side it is on, and
// the gap in percentage points. this is what makes "within 0.08 points" a
// statement the page recomputes rather than remembers
export function closestTo(rows: BacktestRow[], model: string, horizon: number): { model: string; gap: number } | null {
  const mine = rowAt(rows, model, horizon);
  if (!mine || !scored(mine.maePct)) return null;
  let best: { model: string; gap: number } | null = null;
  for (const row of scoredAt(rows, horizon, "maePct")) {
    if (row.model === model) continue;
    const gap = round(Math.abs(row.maePct - mine.maePct), 4);
    if (!best || gap < best.gap) best = { model: row.model, gap };
  }
  return best;
}

// the horizons where this model has the lowest error of all. a tie at the top
// is nobody's win, so the list does not turn on which row the csvs put first
export function winsAt(rows: BacktestRow[], model: string): number[] {
  return horizonsIn(rows).filter((horizon) => {
    const best = bestAt(rows, horizon);
    return best?.model === model && best.margin !== 0;
  });
}

// the horizons where both models are scored and this one has the lower error
export function aheadOf(rows: BacktestRow[], model: string, rival: string): number[] {
  return horizonsIn(rows).filter((horizon) => {
    const mine = rowAt(rows, model, horizon)?.maePct;
    const theirs = rowAt(rows, rival, horizon)?.maePct;
    return scored(mine) && scored(theirs) && mine < theirs;
  });
}

// the horizons where both models are scored
export function bothScored(rows: BacktestRow[], model: string, rival: string): number[] {
  return horizonsIn(rows).filter((horizon) => scored(rowAt(rows, model, horizon)?.maePct) && scored(rowAt(rows, rival, horizon)?.maePct));
}

// the horizons where a rival's error, and apart from that its band width, is
// level with or below this model's, out of every horizon the backtest scored.
// the pipeline picks the shipped network against the other network only and
// never against ridge, so this is what the page and the map read to say how
// ridge compares rather than leaving the choice to look like a contest
export interface Matched {
  horizons: number[];
  error: number[];
  width: number[];
}

export function matchedBy(rows: BacktestRow[], rival: string, model: string): Matched {
  const horizons = horizonsIn(rows);
  const level = (key: "maePct" | "width") => horizons.filter((horizon) => {
    const theirs = rowAt(rows, rival, horizon)?.[key];
    const mine = rowAt(rows, model, horizon)?.[key];
    return scored(theirs) && scored(mine) && theirs <= mine;
  });
  return { horizons, error: level("maePct"), width: level("width") };
}

// true when the rival is level or ahead at every scored horizon on both counts
export function matchedEverywhere(matched: Matched): boolean {
  const every = (list: number[]) => list.length > 0 && list.length === matched.horizons.length;
  return every(matched.error) && every(matched.width);
}

// "at every horizon, on error and on band width", or the horizons where each
// holds when that is not everywhere. null when the rival matches it nowhere
export function matchedPhrase(matched: Matched): string | null {
  if (matchedEverywhere(matched)) return "at every horizon, on error and on band width";
  const at = (list: number[]) => (list.length === matched.horizons.length ? "every horizon" : horizonPhrase(list));
  const parts = [
    matched.error.length > 0 ? `on error at ${at(matched.error)}` : null,
    matched.width.length > 0 ? `on band width at ${at(matched.width)}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" and ");
}

// why the gru is the model on the map, which no retrain changes: the pipeline
// ships whichever network has the lower calibration error at four quarters
export const WHY_SHIPPED = "the pipeline picks between the two networks, not against ridge";

// a gap between two models' errors counts as more than chance when the paired
// test's p value falls under this
export const PAIRED_LEVEL = 0.05;

// the paired test's rows for one rival, by horizon, where it gave a p value
export function pairedWith(rows: PairedRow[], against: string): PairedRow[] {
  return rows.filter((row) => row.against === against && scored(row.pValue)).sort((a, b) => a.horizon - b.horizon);
}

// the horizons where the paired test puts the gap between the two past chance
export function separatedAt(rows: PairedRow[], against: string, level = PAIRED_LEVEL): number[] {
  return pairedWith(rows, against).filter((row) => row.pValue < level).map((row) => row.horizon);
}

// the lowest and highest p value the test gave one rival
export function pRange(rows: PairedRow[], against: string): { low: number; high: number } | null {
  const values = pairedWith(rows, against).map((row) => row.pValue);
  return values.length === 0 ? null : { low: Math.min(...values), high: Math.max(...values) };
}

// "p 0.13 to 0.94", or one p where both ends print alike
export function pPhrase(range: { low: number; high: number }): string {
  const low = points(range.low);
  const high = points(range.high);
  return low === high ? `p ${low}` : `p ${low} to ${high}`;
}

// how many origins the test averaged over, when every row it scored had the same
export function pairedOrigins(rows: PairedRow[]): number | null {
  const counts = new Set(rows.filter((row) => scored(row.pValue)).map((row) => row.origins));
  return counts.size === 1 ? [...counts][0] : null;
}

// a comparison the paired test separates from chance: the rival, the horizons,
// and which side is the closer at them
export interface Separation {
  against: string;
  horizons: number[];
  closer: "shipped" | "rival" | "mixed";
}

// every comparison the test separates from chance, in the table's reading order
export function separations(rows: PairedRow[], level = PAIRED_LEVEL): Separation[] {
  return inOrder(rows.map((row) => row.against)).flatMap((against) => {
    const apart = pairedWith(rows, against).filter((row) => row.pValue < level);
    if (apart.length === 0) return [];
    const closer: Separation["closer"] = apart.every((row) => row.difference < 0)
      ? "shipped"
      : apart.every((row) => row.difference > 0) ? "rival" : "mixed";
    return [{ against, horizons: apart.map((row) => row.horizon), closer }];
  });
}

// what the paired test separates from chance, and on whose side, as the page
// states it: "At the 5 percent level it separates the GRU from no change at
// four and eight quarters, with the GRU closer every time, and it separates
// nothing else." empty when the test scored nothing
export function separatedSentence(rows: PairedRow[], level = PAIRED_LEVEL): string {
  if (!rows.some((row) => scored(row.pValue))) return "";
  const at = `At the ${Math.round(level * 100)} percent level`;
  const found = separations(rows, level);
  if (found.length === 0) return `${at} it separates no gap on the table from chance.`;
  const one = found.every((s) => s.closer === found[0].closer) && found[0].closer !== "mixed";
  const side = (s: Separation) => (s.closer === "shipped"
    ? ", where the GRU is closer"
    : s.closer === "rival" ? `, where ${proseName(s.against)} is closer` : ", with each closer at some of them");
  const parts = found.map((s) => `from ${proseName(s.against)} at ${horizonPhrase(s.horizons)}${one ? "" : side(s)}`);
  const closing = one ? (found[0].closer === "shipped" ? ", with the GRU closer every time" : ", with the other model closer every time") : "";
  return `${at} it separates the GRU ${joinList(parts)}${closing}, and it separates nothing else.`;
}

// the gru against ridge where ridge matches or beats it on the table. when the
// paired test puts every gap between them down to chance the two are tied and
// the pipeline's pick stands. where it separates them it says where
export function ridgeVerdict(rows: PairedRow[], horizons: number[], level = PAIRED_LEVEL): string {
  const tested = pairedWith(rows, "ridge");
  const range = pRange(rows, "ridge");
  if (!range || horizons.length === 0 || !horizons.every((h) => tested.some((row) => row.horizon === h))) {
    return "A penalised linear model is the one to beat on this table.";
  }
  const apart = tested.filter((row) => row.pValue < level);
  if (apart.length === 0) {
    return `The paired test above puts every gap between ridge and the GRU down to chance, ${pPhrase(range)}, so the two are tied. `
      + `The GRU ships because ${WHY_SHIPPED}.`;
  }
  const chance = tested.filter((row) => row.pValue >= level).map((row) => row.horizon);
  const lead = apart.every((row) => row.difference > 0) ? "A penalised linear model is the one to beat on this table" : "The two are not tied";
  return `${lead}: the paired test above separates ridge from the GRU at ${horizonPhrase(apart.map((row) => row.horizon))}`
    + `${chance.length > 0 ? ` and puts ${horizonPhrase(chance)} down to chance` : ""}.`;
}

// the gru against the metro's own long run average, as the paired test reads it
export function meanVerdict(rows: PairedRow[], level = PAIRED_LEVEL): string {
  const range = pRange(rows, LONG_RUN);
  if (!range) return "";
  const tested = pairedWith(rows, LONG_RUN);
  const apart = tested.filter((row) => row.pValue < level);
  if (apart.length === 0) return `No gap between the GRU and that average passes the paired test above, ${pPhrase(range)}.`;
  const chance = tested.filter((row) => row.pValue >= level).map((row) => row.horizon);
  const side = apart.every((row) => row.difference < 0) ? ", the GRU the closer" : apart.every((row) => row.difference > 0) ? ", the average the closer" : "";
  return `The paired test above separates the GRU from that average at ${horizonPhrase(apart.map((row) => row.horizon))}${side}`
    + `${chance.length > 0 ? `, and puts ${horizonPhrase(chance)} down to chance` : ""}.`;
}

// the yearly refit design, ml/src/loop/walkforward.py: the first year a
// model is refitted for, the years whose outcomes chose the online band's
// settings, and the one model the run adds, the gru and ridge averaged
// quantile by quantile. settled, not results
export const REFIT_FROM = 2008;
export const BAND_TUNE = [2012, 2017] as const;
export const AVERAGE = "ensemble";

// the two rules the yearly refit run was held to, both written before it ran.
// ridge or the average replaces the gru only if the paired test on the record
// finds it better at three of the four horizons at 5 percent and worse at
// none, and the online band replaces the static one only if its interval
// score is lower at three of the four horizons on 2022 onward
export const CHALLENGERS = ["ridge", AVERAGE];
export const RULE_HORIZONS = 3;

// the spans the record is scored over, earliest first: the whole record, then
// 2022 onward, the outcomes the fixed split scores
export function spansIn(rows: { span: string }[]): string[] {
  return [...new Set(rows.map((row) => row.span))]
    .filter((span) => quarterSlot(span) !== null)
    .sort((a, b) => quarterSlot(a)! - quarterSlot(b)!);
}

// "2018Q1" as "2018", the way prose names a span that opens with its year
export function spanStart(quarter: string): string {
  return /^\d{4}Q1$/.test(quarter) ? quarter.slice(0, 4) : quarter;
}

// the rows over one span with one band. a band does not move the median, so
// the error is the same with either, and only 2022 onward has a static band
export function spanRows(rows: WalkRow[], span: string | null, band = "online"): WalkRow[] {
  return rows.filter((row) => row.span === span && row.band === band);
}

export function spanPaired(rows: WalkPairedRow[], span: string | null): WalkPairedRow[] {
  return rows.filter((row) => row.span === span);
}

// the cut against another model at every horizon both were scored at
export function errorCuts(rows: BacktestRow[], model: string, over: string): { horizon: number; cut: number }[] {
  return horizonsIn(rows).flatMap((horizon) => {
    const cut = errorCut(rows, model, over, horizon);
    return cut === null ? [] : [{ horizon, cut }];
  });
}

// "cuts the error 24, 34, 43 and 47 percent", a horizon at a time, or what it
// adds to the error where the model is the worse of the two
export function cutWords(cuts: { horizon: number; cut: number }[]): string {
  const list = (part: { cut: number }[]) => `${joinList(part.map((c) => asPercent(Math.abs(c.cut)) ?? "-"))} percent`;
  const down = cuts.filter((c) => c.cut >= 0);
  const up = cuts.filter((c) => c.cut < 0);
  if (cuts.length === 0) return "";
  if (up.length === 0) return `cuts the error ${list(down)}`;
  if (down.length === 0) return `adds ${list(up)} to the error`;
  return `cuts the error ${list(down)} at ${horizonPhrase(down.map((c) => c.horizon))} and adds ${list(up)} to it at `
    + horizonPhrase(up.map((c) => c.horizon));
}

// the p value the paired test gave one rival at one horizon, null where it
// gave none
export function pAt(rows: PairedRow[], against: string, horizon: number): number | null {
  const row = rows.find((r) => r.against === against && r.horizon === horizon);
  return row && scored(row.pValue) ? row.pValue : null;
}

// a p value the way the yearly refit table prints it: two places, three under
// 0.01 or where two would land it on the other side of the level, and
// "<0.001" below that
export function pText(p: number | null | undefined, level = PAIRED_LEVEL): string {
  if (!scored(p)) return "-";
  if (p < 0.001) return "<0.001";
  if (p < 0.01) return p.toFixed(3);
  return (p < level) === (Number(p.toFixed(2)) < level) ? p.toFixed(2) : p.toFixed(3);
}

// "p 0.02", or "p 0.02 and 0.03" for several
export function pList(values: number[], level = PAIRED_LEVEL): string {
  return `p ${joinList(values.map((p) => pText(p, level)))}`;
}

// the round figure every one of these p values is below: "0.002" for a
// largest of 0.0012. null when there is none to bound
export function pBound(values: number[]): string | null {
  const found = values.filter(scored);
  if (found.length === 0) return null;
  const top = Math.max(...found);
  if (top < 0.001) return "0.001";
  const digits = Math.max(1, Math.ceil(-Math.log10(top)));
  const step = 10 ** -digits;
  let bound = Math.ceil(top / step) * step;
  if (bound <= top) bound += step;
  return bound.toFixed(digits);
}

// the horizons where the paired test puts the gap past chance with this side
// the closer: shipped where the gru's error is the lower, rival where the
// other model's is
export function closerAt(rows: PairedRow[], against: string, side: "shipped" | "rival", level = PAIRED_LEVEL): number[] {
  return pairedWith(rows, against)
    .filter((row) => row.pValue < level && (side === "shipped" ? row.difference < 0 : row.difference > 0))
    .map((row) => row.horizon);
}

// what the rule for replacing the gru makes of one rival: the horizons where
// the paired test finds it better past chance, the ones where it finds it
// worse, and whether that is enough to replace the gru
export interface RuleCall {
  against: string;
  better: number[];
  worse: number[];
  replaces: boolean;
}

export function ruleCall(rows: PairedRow[], against: string, level = PAIRED_LEVEL): RuleCall {
  const better = closerAt(rows, against, "rival", level);
  const worse = closerAt(rows, against, "shipped", level);
  return { against, better, worse, replaces: better.length >= RULE_HORIZONS && worse.length === 0 };
}

// the rule and what it found, as the page states it. tied counts the gru
// among the models the table cannot tell apart
export function ruleSentence(calls: RuleCall[], horizons: number, tied: number): string {
  if (calls.length === 0) return "";
  const rule = `The rule, written before the run: ${joinList(calls.map((call) => proseName(call.against)), "or")} `
    + `replaces it only if better at ${inWords(RULE_HORIZONS)} of ${inWords(horizons)} horizons at ${Math.round(PAIRED_LEVEL * 100)} `
    + "percent and worse at none.";
  const up = calls.filter((call) => call.replaces).map((call) => proseName(call.against));
  if (up.length > 0) {
    return `${rule} ${sentenceCase(joinList(up))} ${up.length === 1 ? "is, so by that rule it replaces" : "are, so by that rule one of them replaces"} the GRU.`;
  }
  const none = calls.length === 1 ? "It is not" : calls.length === 2 ? "Neither is" : "None is";
  const table = tied > 1 ? `, one of ${inWords(tied)} tied models rather than a winner` : "";
  return `${rule} ${none}, so the GRU stays${table}.`;
}

// the rivals the record cannot tell from the gru: lower than it at some
// horizon, tested wherever both were scored, never worse than it past chance,
// and better past chance at fewer horizons than the rule asks for. these and
// the gru are the models the table calls tied
export function tiedWith(rows: BacktestRow[], paired: PairedRow[], level = PAIRED_LEVEL): string[] {
  return modelsIn(rows).filter((rival) => {
    if (rival === SHIPPED || aheadOf(rows, rival, SHIPPED).length === 0) return false;
    const tested = pairedWith(paired, rival).map((row) => row.horizon);
    if (!bothScored(rows, rival, SHIPPED).every((horizon) => tested.includes(horizon))) return false;
    const call = ruleCall(paired, rival, level);
    return call.worse.length === 0 && call.better.length < RULE_HORIZONS;
  });
}

// every rival lower than the gru somewhere on the table: the horizons it is
// lower at, and the smallest and largest of those gaps in points
export interface Edge {
  model: string;
  horizons: number[];
  low: number;
  high: number;
}

export function edgesOver(rows: BacktestRow[]): Edge[] {
  return modelsIn(rows).flatMap((rival) => {
    const at = rival === SHIPPED ? [] : aheadOf(rows, rival, SHIPPED);
    if (at.length === 0) return [];
    const gaps = at.map((horizon) => round(rowAt(rows, SHIPPED, horizon)!.maePct - rowAt(rows, rival, horizon)!.maePct, 4));
    return [{ model: rival, horizons: at, low: Math.min(...gaps), high: Math.max(...gaps) }];
  });
}

// "Gradient boosting is lower at all four, by 0.03 to 0.19 points, and ridge
// and the average at three." the rivals lower at the most horizons first
export function edgeSentence(edges: Edge[], horizons: number): string {
  if (edges.length === 0) return "";
  const counts = [...new Set(edges.map((edge) => edge.horizons.length))].sort((a, b) => b - a);
  const [first, ...rest] = counts.map((count) => edges.filter((edge) => edge.horizons.length === count));
  const names = (group: Edge[]) => joinList(group.map((edge) => proseName(edge.model)));
  const low = points(Math.min(...first.map((edge) => edge.low)));
  const high = points(Math.max(...first.map((edge) => edge.high)));
  const count = first[0].horizons.length;
  const at = count === horizons ? `all ${inWords(horizons)}` : `${inWords(count)} of the ${inWords(horizons)}`;
  const lead = `${names(first)} ${first.length === 1 ? "is" : "are"} lower at ${at}, by ${low === high ? low : `${low} to ${high}`} points`;
  const tail = rest.map((group) => `${names(group)} at ${inWords(group[0].horizons.length)}`);
  return `${sentenceCase(lead)}${tail.length > 0 ? `, and ${joinList(tail)}` : ""}.`;
}

// what the paired test makes of those rivals: "The paired test separates none
// of them from the GRU except the average at one quarter (p 0.02)." a gap it
// separates with the gru the closer says so
export function edgeTest(edges: Edge[], paired: PairedRow[], level = PAIRED_LEVEL): string {
  if (edges.length === 0) return "";
  const parts = edges.flatMap((edge) => {
    const apart = pairedWith(paired, edge.model).filter((row) => row.pValue < level);
    const part = (rows: PairedRow[], note: string) => (rows.length === 0
      ? []
      : [`${proseName(edge.model)} at ${horizonPhrase(rows.map((row) => row.horizon))}${note} (${pList(rows.map((row) => row.pValue), level)})`]);
    return [...part(apart.filter((row) => !(row.difference < 0)), ""), ...part(apart.filter((row) => row.difference < 0), ", the GRU the closer")];
  });
  if (parts.length === 0) {
    return edges.length === 1
      ? `The paired test does not separate ${proseName(edges[0].model)} from the GRU.`
      : "The paired test separates none of them from the GRU.";
  }
  return edges.length === 1
    ? `The paired test separates ${joinList(parts)} from the GRU.`
    : `The paired test separates none of them from the GRU except ${joinList(parts)}.`;
}

// the rivals the paired test puts behind the gru past chance at every horizon
export function beatenEverywhere(paired: PairedRow[], horizons: number[], level = PAIRED_LEVEL): string[] {
  if (horizons.length === 0) return [];
  return inOrder(paired.map((row) => row.against)).filter((against) => {
    const at = closerAt(paired, against, "shipped", level);
    return horizons.every((horizon) => at.includes(horizon));
  });
}

// how far the gru's record moves when the index as fhfa prints it today
// replaces the vintages: the largest change in its error at any horizon, in
// points, that change as a share of the error it moved, and the largest
// change in its cut against no change, in percentage points. null when the
// two readings share no scored horizon
export interface Revision {
  error: number;
  share: number;
  cut: number | null;
}

export function revisionOf(vintage: BacktestRow[], latest: BacktestRow[]): Revision | null {
  let found = false;
  let error = 0;
  let share = 0;
  let cut: number | null = null;
  for (const horizon of horizonsIn(vintage)) {
    const was = rowAt(vintage, SHIPPED, horizon)?.maePct;
    const now = rowAt(latest, SHIPPED, horizon)?.maePct;
    if (!scored(was) || !scored(now) || was === 0) continue;
    const move = Math.abs(was - now);
    found = true;
    error = Math.max(error, move);
    share = Math.max(share, move / was);
    const before = errorCut(vintage, SHIPPED, NO_CHANGE, horizon);
    const after = errorCut(latest, SHIPPED, NO_CHANGE, horizon);
    if (before !== null && after !== null) cut = Math.max(cut ?? 0, Math.abs(before - after) * 100);
  }
  return found ? { error, share, cut } : null;
}

// the gru's two bands over one span, a horizon at a time: static, set once on
// the fixed split's calibration block, and online
export interface BandPair {
  horizon: number;
  static: WalkRow;
  online: WalkRow;
}

export function bandPairs(rows: WalkRow[], span: string | null): BandPair[] {
  const mine = rows.filter((row) => row.model === SHIPPED && row.span === span);
  return horizonsIn(mine).flatMap((horizon) => {
    const fixed = mine.find((row) => row.horizon === horizon && row.band === "static");
    const online = mine.find((row) => row.horizon === horizon && row.band === "online");
    return fixed && online ? [{ horizon, static: fixed, online }] : [];
  });
}

// what the band rule makes of the two: the horizons where the online band
// covers more, where its interval score is lower and where it is higher, and
// whether it is lower at enough of them to replace the static band. a cell
// either band left unscored counts for neither side
export interface BandCall {
  horizons: number[];
  coversMore: number[];
  lower: number[];
  higher: number[];
  replaces: boolean;
}

export function bandCall(pairs: BandPair[]): BandCall {
  const where = (key: "coverage" | "intervalScore", keep: (online: number, fixed: number) => boolean) =>
    pairs.filter((pair) => scored(pair.online[key]) && scored(pair.static[key]) && keep(pair.online[key], pair.static[key]))
      .map((pair) => pair.horizon);
  const lower = where("intervalScore", (online, fixed) => online < fixed);
  return {
    horizons: pairs.map((pair) => pair.horizon),
    coversMore: where("coverage", (online, fixed) => online > fixed),
    lower,
    higher: where("intervalScore", (online, fixed) => online > fixed),
    replaces: lower.length >= RULE_HORIZONS,
  };
}

// "covers more and loses on interval score at every horizon", or where each
// holds when that is not everywhere
export function bandWords(call: BandCall): string {
  const every = (list: number[]) => list.length > 0 && list.length === call.horizons.length;
  if (every(call.coversMore) && every(call.higher)) return "covers more and loses on interval score at every horizon";
  const at = (list: number[]) => (every(list) ? "at every horizon" : `at ${horizonPhrase(list)}`);
  const covers = call.coversMore.length > 0 ? `covers more ${at(call.coversMore)}` : "covers no more at any horizon";
  const loses = call.higher.length > 0 ? `loses on interval score ${at(call.higher)}` : "never loses on interval score";
  return `${covers} and ${loses}`;
}

// how much wider the online band is than the static one, in words: "almost
// four times the static width", "12 percent wider than the static band"
export function widthAgainst(online: number, fixed: number): string | null {
  if (!scored(online) || !scored(fixed) || fixed <= 0) return null;
  const ratio = online / fixed;
  if (ratio <= 1) return "no wider than the static band";
  if (ratio < 1.5) {
    const extra = Math.round((ratio - 1) * 100);
    return extra === 0 ? "about as wide as the static band" : `${extra} percent wider than the static band`;
  }
  const whole = Math.round(ratio);
  const hedge = Math.abs(ratio - whole) < 0.05 ? "" : ratio < whole ? "almost " : "more than ";
  return `${hedge}${inWords(whole)} times the static width`;
}

// the admission run's arms, as ml/admit.py names them. the set that ships is
// the nine the old gate could see plus permits and income
export const ARMS = {
  nine: "nine, what the shipped gate could see",
  shipped: "eleven, without zori and listings",
  rents: "eleven, without permits and income",
  all: "thirteen, plus rents listings permits income",
} as const;

// one arm against another, seed for seed over the seeds both ran: how many the
// first has the lower loss on, how much lower its mean loss is, and the wider
// of the two arms' spreads across their own seeds
export interface ArmGap {
  seeds: number;
  wins: number;
  gain: number;
  spread: number;
}

export function armGap(rows: AdmissionRow[], arm: string, base: string): ArmGap | null {
  const losses = (name: string) =>
    new Map(rows.filter((row) => row.arm === name && scored(row.loss)).map((row) => [row.seed, row.loss] as const));
  const mine = losses(arm);
  const theirs = losses(base);
  const seeds = [...mine.keys()].filter((seed) => theirs.has(seed));
  if (seeds.length === 0) return null;
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const spread = (by: Map<number, number>) => Math.max(...by.values()) - Math.min(...by.values());
  return {
    seeds: seeds.length,
    wins: seeds.filter((seed) => mine.get(seed)! < theirs.get(seed)!).length,
    gain: mean(seeds.map((seed) => theirs.get(seed)!)) - mean(seeds.map((seed) => mine.get(seed)!)),
    spread: Math.max(spread(mine), spread(theirs)),
  };
}

// what the admission run found for the four inputs the old gate could not
// see, chosen by the losses it wrote. permits and income against the nine,
// rents and listing prices against the nine, then those two added to the set
// that ships, read against how far one set's own seeds spread
export function admissionSentences(rows: AdmissionRow[]): string {
  const on = (gap: ArmGap) => (gap.wins === gap.seeds ? "on every seed" : `on ${inWords(gap.wins)} of ${inWords(gap.seeds)} seeds`);
  const permits = armGap(rows, ARMS.shipped, ARMS.nine);
  const rents = armGap(rows, ARMS.rents, ARMS.nine);
  const added = armGap(rows, ARMS.all, ARMS.shipped);
  const out: string[] = [];
  if (permits) out.push(`Permits and income beat the set without them ${on(permits)}, and ship.`);
  if (rents && added) {
    const then = added.gain <= 0
      ? "Added to the shipped set they do not lower the validation loss at all, so they stay out"
      : added.gain < added.spread
        ? `Added to the shipped set they win ${on(added)} but gain less than one set's spread across seeds, so they stay out`
        : `Added to the shipped set they win ${on(added)} and gain more than one set's spread across seeds, but they are not in the shipped set yet`;
    out.push(`Rents and listing prices beat it ${on(rents)} as well. ${then}.`);
  }
  return out.join(" ");
}

// fhfa published its expanded data index for 50 metros until its 2026Q1
// report and for every metro since (fhfa technical note 2026m01). the ml
// folder masks it for the rest before that quarter, spec.EXPANDED_BEFORE_2026,
// and the page says so. these are fhfa's facts, not a model's result
export const EXPANDED_BEFORE = 50;
export const EXPANDED_FOR_ALL_FROM = "2026Q1";

// the model's features as the prose names them, keyed as the panel does
export const FEATURE_NAMES: Record<string, string> = {
  hpi_qoq: "quarterly price growth",
  hpi_yoy: "yearly price growth",
  unemp: "unemployment",
  mortgage: "the mortgage rate",
  zhvi_yoy: "Zillow home values",
  hpi_exp_yoy: "the expanded index",
  hpi_rstderr: "the index error",
  permits_per_1000: "permits",
  pop_growth: "population growth",
  domestic_migration_rate: "migration",
  income_growth: "income",
};

export const featureName = (column: string): string => FEATURE_NAMES[column] ?? column;

// "a, b and c", or "a or b" with another word
export function joinList(items: string[], word = "and"): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${word} ${items[items.length - 1]}`;
}

export interface Loss {
  horizon: number;
  winner: string;
  margin: number;
}

// every horizon where some other model is ahead of this one, with the model
// that is ahead and by how much. the page reads its own defeats off the table.
// a model level with the best is not behind it, whichever row came first
export function lossesOf(rows: BacktestRow[], model: string): Loss[] {
  const losses: Loss[] = [];
  for (const horizon of horizonsIn(rows)) {
    const mine = rowAt(rows, model, horizon);
    const best = bestAt(rows, horizon);
    if (!mine || !scored(mine.maePct) || !best || best.model === model) continue;
    const margin = round(mine.maePct - best.maePct, 4);
    if (margin !== 0) losses.push({ horizon, winner: best.model, margin });
  }
  return losses;
}

// the losses written out, with a rival named once however many horizons it
// takes: "ridge is ahead at one quarter by 0.11 points and at two by 0.09"
export function lossSentence(losses: Loss[]): string {
  const groups: { winner: string; parts: string[] }[] = [];
  for (const loss of losses) {
    const part = `at ${horizonPhrase([loss.horizon])} by ${points(loss.margin)} points`;
    const last = groups[groups.length - 1];
    if (last && last.winner === loss.winner) last.parts.push(part);
    else groups.push({ winner: loss.winner, parts: [part] });
  }
  return groups
    .map((group) => `${modelLabel(group.winner)} is ahead ${joinAnd(group.parts)}`)
    .join(", and ");
}

function joinAnd(parts: string[]): string {
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function sentenceCase(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

// how much of another model's error this one removes, as a share. null when
// either row is missing or the comparison would divide by zero
export function errorCut(rows: BacktestRow[], model: string, over: string, horizon: number): number | null {
  const mine = rowAt(rows, model, horizon);
  const theirs = rowAt(rows, over, horizon);
  // an mae the backtest could not score is missing, and a missing one read as
  // zero claims either the strongest possible result or an infinite loss
  if (!mine || !theirs || !Number.isFinite(mine.maePct) || !Number.isFinite(theirs.maePct) || theirs.maePct === 0) return null;
  return round(1 - mine.maePct / theirs.maePct, 4);
}

// the same reading for the band: how much narrower this model's interval is
export function bandCut(rows: BacktestRow[], model: string, over: string, horizon: number): number | null {
  const mine = rowAt(rows, model, horizon);
  const theirs = rowAt(rows, over, horizon);
  // a width the backtest could not score is missing, and a missing width read
  // as zero would claim a band 100 percent narrower than the one it is against
  if (!mine || !theirs || !Number.isFinite(mine.width) || !Number.isFinite(theirs.width) || theirs.width === 0) return null;
  return round(1 - mine.width / theirs.width, 4);
}

// the spread of coverage at a horizon, worst and best, for the limits: every
// model covers too little at eight quarters and the page has to say how much
export function coverageRange(rows: BacktestRow[], horizon: number): { low: BacktestRow; high: BacktestRow } | null {
  const at = scoredAt(rows, horizon, "coverage");
  return at.length === 0 ? null : { low: at[0], high: at[at.length - 1] };
}

// true when no model at this horizon reaches the nominal coverage, which is
// the claim the limits section makes about eight quarters. a model with no
// coverage cannot vouch for it either way, and a horizon with none is false
export function allUnderCover(rows: BacktestRow[], horizon: number, nominal = NOMINAL_COVERAGE): boolean {
  const at = scoredAt(rows, horizon, "coverage");
  return at.length > 0 && at.every((row) => row.coverage < nominal);
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen"];

export function horizonWord(horizon: number): string {
  return WORDS[horizon] ?? String(horizon);
}

// a count the prose was not written with. the page used to say "ten series"
// in type, and went on saying it for two commits after the input set was cut
export function inWords(count: number): string {
  return Number.isInteger(count) && count >= 0 ? WORDS[count] ?? String(count) : String(count);
}

// "one quarter", "one and two quarters", "one, two and eight quarters"
export function horizonPhrase(horizons: number[]): string {
  const words = horizons.map(horizonWord);
  if (words.length === 0) return "";
  if (words.length === 1) return `${words[0]} ${horizons[0] === 1 ? "quarter" : "quarters"}`;
  const last = words[words.length - 1];
  return `${words.slice(0, -1).join(", ")} and ${last} quarters`;
}

// "2026-06" is the last month of the origin quarter, which is how every
// forecast field on the map is dated
export function quarterLabel(date: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})/.exec(String(date ?? ""));
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}Q${Math.ceil(month / 3)}`;
}

export type ForecastField = "hpi_forecast_4q" | "hpi_forecast_8q";

export interface Named {
  name: string;
  value: number;
}

// what the shipped model is saying right now, read off the same json the map
// draws. quoting ml/README.md instead would drift the first time the bot
// carried a newer export than the one the README was written against
export interface Spread {
  count: number;
  median: number;
  p10: number;
  p90: number;
  lowest: Named;
  highest: Named;
  falling: number;
  origin: string | null;
}

export function spreadOf(metros: Metro[], field: keyof YearValues): Spread | null {
  const named: Named[] = [];
  let origin: string | null = null;
  for (const metro of metros) {
    const value = fieldAt(metro, "latest", field);
    if (value === null) continue;
    named.push({ name: metro.name, value });
    if (!origin) origin = quarterLabel(dateAt(metro, "latest", field));
  }
  if (named.length === 0) return null;
  const sorted = [...named].sort((a, b) => a.value - b.value);
  const values = sorted.map((entry) => entry.value);
  return {
    count: named.length,
    median: quantile(values, 0.5),
    p10: quantile(values, 0.1),
    p90: quantile(values, 0.9),
    lowest: sorted[0],
    highest: sorted[sorted.length - 1],
    falling: values.filter((value) => value < 0).length,
    origin,
  };
}

// linear interpolation between the two nearest ranks, the convention the ml
// folder's own percentiles use
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const at = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

// a band on one metro, for the line that shows how wide "wide" is
export function bandOf(metro: Metro | undefined, field: ForecastField): { point: number; lo: number; hi: number } | null {
  if (!metro) return null;
  const point = fieldAt(metro, "latest", field);
  const lo = num((metro.latest as unknown as Record<string, unknown>)?.[`${field}_lo`]);
  const hi = num((metro.latest as unknown as Record<string, unknown>)?.[`${field}_hi`]);
  return point === null || lo === null || hi === null ? null : { point, lo, hi };
}

export interface NamedBand {
  name: string;
  point: number;
  lo: number;
  hi: number;
}

// the narrowest and widest band on the map at a horizon. the narrow end is
// the one that matters: it is how wide this forecast gets even at its surest
export function bandExtremes(metros: Metro[], field: ForecastField): { narrow: NamedBand; wide: NamedBand } | null {
  let narrow: NamedBand | null = null;
  let wide: NamedBand | null = null;
  for (const metro of metros) {
    const band = bandOf(metro, field);
    if (!band) continue;
    const named = { name: metro.name, ...band };
    const span = band.hi - band.lo;
    if (!narrow || span < narrow.hi - narrow.lo) narrow = named;
    if (!wide || span > wide.hi - wide.lo) wide = named;
  }
  return narrow && wide ? { narrow, wide } : null;
}

// a share as whole percent, for prose that says "45 percent"
export function asPercent(share: number | null): string | null {
  return share === null || !Number.isFinite(share) ? null : String(Math.round(share * 100));
}

export function points(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

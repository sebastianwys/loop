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
  windowmlp: "window mlp",
  seqgru: "sequence gru",
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
// the pipeline's pick stands; where it separates them it says where
export function ridgeVerdict(rows: PairedRow[], horizons: number[], level = PAIRED_LEVEL): string {
  const tested = pairedWith(rows, "ridge");
  const range = pRange(rows, "ridge");
  if (!range || horizons.length === 0 || !horizons.every((h) => tested.some((row) => row.horizon === h))) {
    return "A penalised linear model is the one to beat on this table.";
  }
  const apart = tested.filter((row) => row.pValue < level);
  if (apart.length === 0) {
    return `The paired test above puts every gap between ridge and the GRU down to chance, ${pPhrase(range)}, so the two are tied, `
      + `and the GRU ships because ${WHY_SHIPPED}.`;
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
      ? "but added to the shipped set they do not lower the validation loss at all, so they stay out"
      : added.gain < added.spread
        ? `but added to the shipped set they lower the validation loss by less than the spread across one set's seeds, winning ${on(added)}, so they stay out`
        : `and added to the shipped set they lower the validation loss by more than the spread across one set's seeds, winning ${on(added)}, though they are not in the shipped set yet`;
    out.push(`Rents and listing prices beat the set without them ${on(rents)} as well, ${then}.`);
  }
  return out.join(" ");
}

// fhfa published its expanded-data index for 50 metros until its 2026Q1
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

// "a, b and c"
export function joinList(items: string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
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

// how much of another model's error this one removes, as a share. null when
// either row is missing or the comparison would divide by zero
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
// model under-covers at eight quarters and the page has to say by how much
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
// draws. quoting the write-up instead would drift the first time the bot
// carried a newer export than the one the write-up was written against
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

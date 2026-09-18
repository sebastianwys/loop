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

// the model that ships to the map, and the two it is read against: the rule
// that says nothing changes, and the metro's own fifty year average
export const SHIPPED = "seqgru";
export const NO_CHANGE = "no_change";
export const LONG_RUN = "metro_mean";
export const NOMINAL_COVERAGE = 0.9;

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

export function rowAt(rows: BacktestRow[], model: string, horizon: number): BacktestRow | null {
  return rows.find((row) => row.model === model && row.horizon === horizon) ?? null;
}

// the horizons the csvs actually carry, so the table's columns follow the
// backtest rather than a list written here
export function horizonsIn(rows: BacktestRow[]): number[] {
  return [...new Set(rows.map((row) => row.horizon))].sort((a, b) => a - b);
}

export function modelsIn(rows: BacktestRow[]): string[] {
  const present = new Set(rows.map((row) => row.model));
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

// the lowest error at a horizon and how far back the next model is. a tie
// leaves the margin at zero rather than picking a winner by row order
export interface Standing {
  model: string;
  maePct: number;
  runnerUp: string | null;
  margin: number | null;
}

export function bestAt(rows: BacktestRow[], horizon: number): Standing | null {
  const at = rows.filter((row) => row.horizon === horizon).sort((a, b) => a.maePct - b.maePct);
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
  if (!mine) return null;
  let best: { model: string; gap: number } | null = null;
  for (const row of rows) {
    if (row.horizon !== horizon || row.model === model) continue;
    const gap = round(Math.abs(row.maePct - mine.maePct), 4);
    if (!best || gap < best.gap) best = { model: row.model, gap };
  }
  return best;
}

export interface Loss {
  horizon: number;
  winner: string;
  margin: number;
}

// every horizon where some other model is ahead of this one, with the model
// that is ahead and by how much. the page reads its own defeats off the table
export function lossesOf(rows: BacktestRow[], model: string): Loss[] {
  const losses: Loss[] = [];
  for (const horizon of horizonsIn(rows)) {
    const mine = rowAt(rows, model, horizon);
    const best = bestAt(rows, horizon);
    if (!mine || !best || best.model === model) continue;
    losses.push({ horizon, winner: best.model, margin: round(mine.maePct - best.maePct, 4) });
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
  const at = rows.filter((row) => row.horizon === horizon).sort((a, b) => a.coverage - b.coverage);
  return at.length === 0 ? null : { low: at[0], high: at[at.length - 1] };
}

// true when no model at this horizon reaches the nominal coverage, which is
// the claim the limits section makes about eight quarters
export function allUnderCover(rows: BacktestRow[], horizon: number, nominal = NOMINAL_COVERAGE): boolean {
  const at = rows.filter((row) => row.horizon === horizon);
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

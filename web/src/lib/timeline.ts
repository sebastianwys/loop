import type { AnnualSeries, Metro, MetroSeries, Period } from "../types";
import {
  PERIODS, SOURCE_LABEL, availablePeriods, dateAt, defDate, DEFS, num,
  type Metric, type MetricDef, type Source,
} from "./metrics";

// the axis starts at the first vintage year and always runs past the last
// one, so a latest tick has room even before any source reports a date
export const AXIS_START = 2014;
export const AXIS_MIN_END = 2025;

// the track width the label layout assumes: the sidebar's content width
// less the room the end labels need on either side
export const AXIS_WIDTH = 252;
// two ticks closer than this are pushed apart so both stay visible
const MIN_TICK_GAP = 14;
// two labels closer than this share a row badly, so the later drops a row
const LABEL_GAP = 60;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const CHANGE = /_(\d{2})_(\d{2})$/;

const r4 = (v: number) => Math.round(v * 10000) / 10000;

function parts(date: string | null | undefined): { year: number; month: number | null; day: number | null } | null {
  if (typeof date !== "string") return null;
  const m = DATE.exec(date.trim());
  if (!m) return null;
  const month = m[2] ? Number(m[2]) : null;
  const day = m[3] ? Number(m[3]) : null;
  if (month !== null && (month < 1 || month > 12)) return null;
  if (day !== null && (day < 1 || day > 31)) return null;
  return { year: Number(m[1]), month, day };
}

// a date as a fractional calendar year. a bare year sits at its start, a
// month at its start, a day at its place within the month
export function dateToYear(date: string | null | undefined): number | null {
  const p = parts(date);
  if (!p) return null;
  const month = p.month ?? 1;
  const day = p.day ?? 1;
  return r4(p.year + (month - 1 + (day - 1) / 31) / 12);
}

// "Jul 2026" for a month or a day. a bare year is the year, or a fiscal
// year for hud, which publishes rents and income limits by fiscal year
export function dateLabel(date: string | null | undefined, source?: Source): string | null {
  const p = parts(date);
  if (!p) return typeof date === "string" && date.trim() ? date : null;
  if (p.month === null) return source === "hud" ? `FY ${p.year}` : String(p.year);
  return `${MONTHS[p.month - 1]} ${p.year}`;
}

// the newest date any latest field carries, as a fractional year
export function newestYear(metros: Metro[]): number | null {
  let newest: number | null = null;
  for (const m of metros) {
    const latest = m?.latest as unknown as Record<string, unknown> | undefined;
    if (!latest) continue;
    for (const key of Object.keys(latest)) {
      if (!key.endsWith("_date")) continue;
      const year = dateToYear(latest[key] as string);
      if (year !== null && (newest === null || year > newest)) newest = year;
    }
  }
  return newest;
}

export function axisEnd(metros: Metro[]): number {
  return Math.max(AXIS_MIN_END, newestYear(metros) ?? AXIS_MIN_END);
}

// the newest date the definition carries at latest across the metros
export function latestDate(def: MetricDef, metros: Metro[]): string | null {
  let newest: string | null = null;
  let newestYear = -Infinity;
  for (const m of metros) {
    const date = dateAt(m, "latest", def.dateId ?? def.id);
    const year = dateToYear(date);
    if (date && year !== null && year > newestYear) {
      newest = date;
      newestYear = year;
    }
  }
  return newest;
}

// metros with a value at each declared period. an undeclared period counts
// nothing, whatever the panels hold, because the definition is not read there
export function periodCounts(def: MetricDef, metros: Metro[]): Record<Period, number> {
  const counts: Record<Period, number> = { "2014": 0, "2019": 0, "2024": 0, latest: 0 };
  for (const p of def.periods) {
    let n = 0;
    for (const m of metros) if (def.valueAt(m, p) !== null) n += 1;
    counts[p] = n;
  }
  return counts;
}

// the published periods of every definition, keyed by id, for the detail
// panel's tables. before data loads, the declared lists
export function publishedPeriods(metros: Metro[]): Record<string, Period[]> {
  const out: Record<string, Period[]> = {};
  for (const def of DEFS) out[def.id] = availablePeriods(def, metros);
  return out;
}

// the two years a change figure spans, read from ids like hpi_19_24
export function changeSpan(def: MetricDef): { from: number; to: number } | null {
  if (def.periods.length > 0) return null;
  const m = CHANGE.exec(def.id);
  return m ? { from: 2000 + Number(m[1]), to: 2000 + Number(m[2]) } : null;
}

export interface TimelineTick {
  period: Period;
  // the year, or the latest date in words; "latest" when no date is known
  label: string;
  date: string | null;
  year: number;
  // position along the axis, 0 at the start and 1 at the end
  t: number;
  count: number;
  available: boolean;
  // label row: 1 when the tick crowds its neighbour on the first row
  row: 0 | 1;
}

export interface TimelineSpan {
  from: number;
  to: number;
  t0: number;
  t1: number;
}

export interface Timeline {
  start: number;
  end: number;
  ticks: TimelineTick[];
  marks: { year: number; t: number }[];
  span: TimelineSpan | null;
}

// ticks in axis order keep a minimum gap so two at the same date, like a
// latest that is the 2024 figure, stay distinct, and a label drops to the
// second row when the label before it is too close
function spread(ticks: TimelineTick[], width: number): void {
  const order = [...ticks].sort((a, b) => a.t - b.t);
  const gap = MIN_TICK_GAP / width;
  for (let i = 1; i < order.length; i++) {
    if (order[i].t < order[i - 1].t + gap) order[i].t = r4(Math.min(1, order[i - 1].t + gap));
  }
  const last: [number, number] = [-Infinity, -Infinity];
  for (const tick of order) {
    const x = tick.t * width;
    let row: 0 | 1 = 0;
    if (x - last[0] < LABEL_GAP) row = x - last[1] > x - last[0] ? 1 : 0;
    tick.row = row;
    last[row] = x;
  }
}

// one tick per period, whether the definition has it or not, so the reader
// sees which of the four are published. a change figure has no ticks, only
// the span it covers
export function buildTimeline(def: MetricDef, metros: Metro[], width = AXIS_WIDTH): Timeline {
  const start = AXIS_START;
  const end = axisEnd(metros);
  const at = (year: number) => r4(Math.min(1, Math.max(0, (year - start) / (end - start))));
  const marks: { year: number; t: number }[] = [];
  for (let year = start; year <= end; year++) marks.push({ year, t: at(year) });

  if (def.periods.length === 0) {
    const span = changeSpan(def);
    return { start, end, ticks: [], marks, span: span ? { ...span, t0: at(span.from), t1: at(span.to) } : null };
  }

  const counts = periodCounts(def, metros);
  // a panel may carry a date for a field the definition never reads at
  // latest, so an undeclared latest sits at the end of the axis, undated
  const date = def.periods.includes("latest") ? latestDate(def, metros) : null;
  const ticks = PERIODS.map((period): TimelineTick => {
    const declared = def.periods.includes(period);
    const count = counts[period];
    const available = declared && (metros.length === 0 || count > 0);
    const year = period === "latest" ? (dateToYear(date) ?? end) : Number(period);
    const label = period === "latest" ? (dateLabel(date, def.source) ?? "latest") : period;
    return { period, label, date: period === "latest" ? date : null, year, t: at(year), count, available, row: 0 };
  });
  spread(ticks, width);
  return { start, end, ticks, marks, span: null };
}

// the available period after the current one, the first when the current
// is not available, null at the end
export function nextPeriod(current: Period | null, available: Period[]): Period | null {
  if (available.length === 0) return null;
  const i = current ? available.indexOf(current) : -1;
  if (i < 0) return available[0];
  return i + 1 < available.length ? available[i + 1] : null;
}

export function prevPeriod(current: Period | null, available: Period[]): Period | null {
  if (available.length === 0) return null;
  const i = current ? available.indexOf(current) : -1;
  if (i < 0) return available[available.length - 1];
  return i > 0 ? available[i - 1] : null;
}

// ---- deep annual histories ----

// the definitions an annual history backs, and the series each one reads. the
// house price index is the only measure whose source publishes a full annual
// run; every other definition keeps the four vintage panels, which is all the
// acs, the permits survey and the rest report
export const DEEP_DEFS: Record<string, keyof MetroSeries> = { hpi: "hpi" };

// the colour domain is the nearest round number to this quantile of every
// change the run carries, which on the built data is ten percent. wider caps
// were measured and they wash the map out: at twenty percent the neutral
// middle class holds two fifths of the country in an ordinary year and nine
// tenths of it in 2012. at ten percent it holds a fifth, the crash years
// spread across three classes, and only the 2021 and 2022 booms peg the top,
// which is a true thing to say about 2021 and 2022
const CAP_QUANTILE = 0.9;
const CAP_STEP = 5;
const CAP_MIN = 5;

export function seriesOf(metro: Metro, key: keyof MetroSeries): AnnualSeries | null {
  const series = metro?.series?.[key];
  if (!series || !Array.isArray(series.values) || !Number.isFinite(series.start)) return null;
  return series;
}

// the level a calendar year holds, null outside the run or where the year is
// missing. a missing year is not a zero, so it stays null all the way out
export function levelAt(series: AnnualSeries | null, year: number): number | null {
  if (!series) return null;
  const i = year - series.start;
  return i < 0 || i >= series.values.length ? null : num(series.values[i]);
}

// the change into a year, in percent. fhfa rebases the index to 100 at each
// metro's own first quarter, so two metros' levels say nothing side by side
// while their growth rates are the same measurement everywhere
export function growthAt(series: AnnualSeries | null, year: number): number | null {
  const from = levelAt(series, year - 1);
  const to = levelAt(series, year);
  if (from === null || to === null || from <= 0) return null;
  return (to / from - 1) * 100;
}

export interface DeepFrame {
  year: number;
  // position along the scrubber, 0 at the first frame and 1 at the last
  t: number;
  // metros with a growth value this year. the rest have no index yet
  count: number;
  // the year stops at the series' as of quarter rather than running whole
  partial: boolean;
}

export interface DeepTimeline {
  key: keyof MetroSeries;
  frames: DeepFrame[];
  // metros in the build, the denominator every count is read against
  total: number;
  // the colour domain, the same plus and minus in every frame
  cap: number;
  // the quarter the partial last frame runs to, when the series agree on one
  asOf: string | null;
}

const roundTo = (value: number, step: number) => Math.round(value / step) * step;

// the value at a quantile of an ascending array, by nearest rank
function quantileOf(sorted: number[], q: number): number {
  const i = Math.floor((sorted.length - 1) * q);
  return sorted[Math.min(sorted.length - 1, Math.max(0, i))];
}

// one frame per calendar year the histories cover, trimmed to the years that
// carry a growth value. null when this definition has no history behind it,
// which is what puts the four vintage panels back on screen
export function buildDeepTimeline(def: MetricDef, metros: Metro[]): DeepTimeline | null {
  const key = DEEP_DEFS[def.id];
  if (!key) return null;
  const all: AnnualSeries[] = [];
  for (const metro of metros) {
    const series = seriesOf(metro, key);
    if (series) all.push(series);
  }
  if (all.length === 0) return null;

  const counts = new Map<number, number>();
  const partials = new Set<number>();
  const magnitudes: number[] = [];
  let first = Infinity;
  let last = -Infinity;
  for (const series of all) {
    if (typeof series.partial_year === "number") partials.add(series.partial_year);
    const end = series.start + series.values.length - 1;
    for (let year = series.start + 1; year <= end; year++) {
      const growth = growthAt(series, year);
      if (growth === null) continue;
      counts.set(year, (counts.get(year) ?? 0) + 1);
      magnitudes.push(Math.abs(growth));
      if (year < first) first = year;
      if (year > last) last = year;
    }
  }
  if (magnitudes.length === 0) return null;

  magnitudes.sort((a, b) => a - b);
  const cap = Math.max(CAP_MIN, roundTo(quantileOf(magnitudes, CAP_QUANTILE), CAP_STEP));

  const span = last - first;
  const frames: DeepFrame[] = [];
  for (let year = first; year <= last; year++) {
    frames.push({
      year,
      t: span === 0 ? 0 : r4((year - first) / span),
      count: counts.get(year) ?? 0,
      partial: partials.has(year),
    });
  }
  const quarters = new Set(all.map((s) => s.as_of).filter((q): q is string => typeof q === "string" && q.length > 0));
  return { key, frames, total: metros.length, cap, asOf: quarters.size === 1 ? [...quarters][0] : null };
}

// the frame a year names, clamped into the run. a year the reader never chose
// lands on the last frame, the newest the histories reach
export function frameIndex(deep: DeepTimeline, year: number | null): number {
  const n = deep.frames.length;
  if (n === 0) return 0;
  if (year === null || !Number.isFinite(year)) return n - 1;
  return Math.min(n - 1, Math.max(0, Math.round(year - deep.frames[0].year)));
}

export function frameAt(deep: DeepTimeline, year: number | null): DeepFrame {
  return deep.frames[frameIndex(deep, year)];
}

// the frame a run moves to next, -1 once the run has reached the end. a run
// stops at the newest year rather than looping, so the map settles on the
// figure a reader who walked away would want to be looking at
export function nextFrame(index: number, count: number): number {
  return index >= 0 && index + 1 < count ? index + 1 : -1;
}

// "1990", or "2026 so far" for a year that stops at the as of quarter
export function frameName(frame: { year: number; partial: boolean }): string {
  return frame.partial ? `${frame.year} so far` : String(frame.year);
}

// what the scrubber reports: the year, and how much of the country had an
// index that year, since an early year is mostly blank map
export function frameText(frame: DeepFrame, total: number): string {
  return `${frameName(frame)}, ${frame.count} of ${total} metros`;
}

// a definition read at one year of its annual history. Metric carries no year,
// and metrics.ts is not this module's to change, so this widens it instead
export interface YearMetric extends Metric {
  year: number;
  partial: boolean;
}

export function isYearMetric(metric: Metric): metric is YearMetric {
  return typeof (metric as YearMetric).year === "number";
}

// growth rather than the level, on a diverging ramp: a level map cannot show
// a crash, because a rebased index barely dips, and the bases differ by metro
export function yearMetric(def: MetricDef, deep: DeepTimeline, year: number | null): YearMetric {
  const frame = frameAt(deep, year);
  const key = deep.key;
  return {
    id: `${def.id}_y${frame.year}`,
    def,
    period: null,
    year: frame.year,
    partial: frame.partial,
    label: `${def.label} growth, ${frame.year - 1} to ${frameName(frame)}`,
    format: "rate",
    kind: "diverging",
    group: def.group,
    source: def.source,
    accessor: (m) => growthAt(seriesOf(m, key), frame.year),
    dateOf: () => String(frame.year),
  };
}

// the legend line under an animated year: where the number is from, the two
// years it spans, and that the colours do not move when the year does
export function deepCaption(def: MetricDef, deep: DeepTimeline, year: number | null): string {
  const frame = frameAt(deep, year);
  const to = frame.partial && deep.asOf ? deep.asOf : String(frame.year);
  return `Source: ${SOURCE_LABEL[def.source]}, ${frame.year - 1} to ${to}. One colour scale for every year.`;
}

// the period a value on the map belongs to, in words: the year, the
// metro's own latest date, or the years a change figure spans
export function periodLabel(metric: Metric, metro: Metro): string {
  // a year off an annual history names itself: it is not one of the panels
  if (isYearMetric(metric)) return frameName(metric);
  if (!metric.period) {
    const span = changeSpan(metric.def);
    return span ? `${span.from} to ${span.to}` : "";
  }
  if (metric.period !== "latest") return metric.period;
  return dateLabel(metric.dateOf(metro), metric.source) ?? "latest";
}

// why a source has nothing at the first vintage year, when the reason is the
// source's own and not this metro's. a blank year reads as "never published"
// rather than "unknown" once the note says so
const LATE_START: Partial<Record<Source, string>> = {
  hud: "HUD publishes no fair market rents or income limits before fiscal 2017.",
};

// "From 2019: Median listing price, Active listings." for the measures in a
// table whose first published period comes after the first vintage year,
// followed by the reason each late source gives
export function laterStartsNote(rows: { label: string; periods: Period[]; source?: Source }[]): string | null {
  const byStart = new Map<string, string[]>();
  const reasons = new Set<string>();
  for (const row of rows) {
    const first = row.periods[0];
    if (!first || first === PERIODS[0]) continue;
    const labels = byStart.get(first) ?? [];
    labels.push(row.label);
    byStart.set(first, labels);
    const why = row.source ? LATE_START[row.source] : undefined;
    if (why) reasons.add(why);
  }
  if (byStart.size === 0) return null;
  const starts = [...byStart.entries()]
    .sort((a, b) => PERIODS.indexOf(a[0] as Period) - PERIODS.indexOf(b[0] as Period))
    .map(([start, labels]) => `From ${start}: ${labels.join(", ")}.`);
  return [...starts, ...reasons].join(" ");
}

export interface LatestColumn {
  show: boolean;
  // the one date every row shares, null when they differ
  header: string | null;
  dates: Record<string, string | null>;
}

// the latest column of a detail table: shown when a row has a latest value
// for this metro. the header carries the date when every row shares one,
// otherwise each cell shows its own
export function latestColumn(metro: Metro, rows: MetricDef[]): LatestColumn {
  const dates: Record<string, string | null> = {};
  const seen = new Set<string>();
  for (const d of rows) {
    if (!d.periods.includes("latest") || d.valueAt(metro, "latest") === null) continue;
    const label = dateLabel(defDate(d, metro, "latest"), d.source);
    dates[d.id] = label;
    if (label) seen.add(label);
  }
  const show = Object.keys(dates).length > 0;
  return { show, header: show && seen.size === 1 ? [...seen][0] : null, dates };
}

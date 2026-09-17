import type { Metro, Period } from "../types";
import { PERIODS, availablePeriods, dateAt, defDate, DEFS, type Metric, type MetricDef, type Source } from "./metrics";

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

// the period a value on the map belongs to, in words: the year, the
// metro's own latest date, or the years a change figure spans
export function periodLabel(metric: Metric, metro: Metro): string {
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

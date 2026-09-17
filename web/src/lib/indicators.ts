import type { Indicator, IndicatorFormat, IndicatorGroup, IndicatorPoint, MapData, MortgageRate } from "../types";
import { formatValue } from "./format";
import type { ValueFormat } from "./metrics";
import { buildSparkline, type Spark } from "./sparkline";
import { dateLabel } from "./timeline";

// the strip always reads in this order, whatever order the json carries
export const INDICATOR_GROUPS: IndicatorGroup[] = ["Prices", "Rates", "Consumers"];

// the tile sparkline, small enough to sit beside the value
export const SPARK_W = 80;
export const SPARK_H = 24;
export const SPARK_PAD = 3;

// the expanded chart. its width follows the strip, so only the height and
// the padding are fixed here
export const CHART_H = 100;
export const CHART_PAD = 12;
export const CHART_W = 720;

// the one detail row under the strip. every tile controls it
export const DETAIL_ID = "national-indicator-detail";

// the header keeps its own mortgage stat until a tile carries the same rate
export const MORTGAGE_ID = "mortgage";

const MONTH = /^\d{4}-\d{2}/;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export const groupId = (group: IndicatorGroup): string => `indicator-group-${group.toLowerCase()}`;

export const tileId = (id: string): string => `indicator-tile-${id}`;

// a point is usable only with a month and a finite value
function readPoint(raw: unknown): IndicatorPoint | null {
  const p = raw as Partial<IndicatorPoint> | null;
  const value = num(p?.value);
  if (!p || value === null || !MONTH.test(text(p.date))) return null;
  return { date: p.date as string, value };
}

export function readHistory(raw: unknown): IndicatorPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(readPoint).filter((p): p is IndicatorPoint => p !== null);
}

// one indicator, or null when a field the strip needs is missing, so a
// half written entry drops out instead of rendering as a broken tile
export function readIndicator(raw: unknown): Indicator | null {
  const i = raw as Partial<Indicator> | null;
  const value = num(i?.value);
  const id = text(i?.id);
  if (!i || !id || value === null) return null;
  if (!INDICATOR_GROUPS.includes(i.group as IndicatorGroup)) return null;
  const format: IndicatorFormat = i.format === "rate" || i.format === "index" ? i.format : "pct";
  return {
    id,
    label: text(i.label) || id,
    group: i.group as IndicatorGroup,
    format,
    provider: text(i.provider),
    note: text(i.note),
    value,
    date: text(i.date),
    change_12m: num(i.change_12m),
    history: readHistory(i.history),
  };
}

// the national indicators of a build, empty whenever it carries none
export function nationalIndicators(data: MapData | null | undefined): Indicator[] {
  const raw = data?.national?.indicators;
  if (!Array.isArray(raw)) return [];
  return raw.map(readIndicator).filter((i): i is Indicator => i !== null);
}

export interface IndicatorBlock {
  group: IndicatorGroup;
  id: string;
  indicators: Indicator[];
}

// the groups in the fixed order, keeping the json's order inside each one.
// a group without indicators is left out rather than shown empty
export function groupIndicators(indicators: Indicator[]): IndicatorBlock[] {
  return INDICATOR_GROUPS.map((group) => ({
    group,
    id: groupId(group),
    indicators: indicators.filter((i) => i.group === group),
  })).filter((block) => block.indicators.length > 0);
}

// the values arrive in display units, so a percent uses the rate format,
// which prints 2.9 as 2.9%. pct would multiply it by a hundred
export function displayFormat(format: IndicatorFormat): ValueFormat {
  return format === "index" ? "index" : "rate";
}

export function indicatorValue(indicator: Indicator): string {
  return formatValue(indicator.value, displayFormat(indicator.format));
}

export type ChangeDirection = "up" | "down" | "flat" | "none";

export interface ChangeChip {
  direction: ChangeDirection;
  // the signed figure, or the phrase that stands in for it
  text: string;
  // the direction in a word, so the color is never the only carrier
  word: string;
  // the whole chip read out in full
  label: string;
}

// the change over twelve months in percentage or index points. a figure
// that rounds to zero at the printed precision reads as no change, never
// as a signed zero
export function changeChip(change: number | null): ChangeChip {
  const value = num(change);
  if (value === null) {
    return { direction: "none", text: "not reported", word: "", label: "twelve month change not reported" };
  }
  // the magnitude is rounded first, so a rise and a fall of the same size
  // print the same figure
  const rounded = Math.round(Math.abs(value) * 10) / 10;
  if (rounded === 0) {
    return { direction: "flat", text: "no change", word: "", label: "no change over twelve months" };
  }
  const up = value > 0;
  const size = `${rounded.toFixed(1)} pts`;
  return {
    direction: up ? "up" : "down",
    text: `${up ? "+" : "-"}${size}`,
    word: up ? "up" : "down",
    label: `${up ? "up" : "down"} ${size} over twelve months`,
  };
}

// "2026-08" reads as "Aug 2026", the same words the timeline uses
export function monthLabel(date: string | null | undefined): string {
  return dateLabel(date) ?? "";
}

// the months a history covers, "Sep 2023 to Aug 2026", or the one month
// it holds
export function rangeLabel(history: IndicatorPoint[]): string {
  if (history.length === 0) return "";
  const first = monthLabel(history[0].date);
  const last = monthLabel(history[history.length - 1].date);
  return first === last ? first : `${first} to ${last}`;
}

// "2026-08" as a count of months, so two months can be compared and
// counted apart
function monthSlot(date: string): number | null {
  const m = /^(\d{4})-(\d{2})/.exec(date);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return Number(m[1]) * 12 + month - 1;
}

function slotDate(slot: number): string {
  return `${String(Math.floor(slot / 12)).padStart(4, "0")}-${String((slot % 12) + 1).padStart(2, "0")}`;
}

export interface HistoryGrid {
  dates: string[];
  values: (number | null)[];
}

// the history laid on a calendar, one slot a month, with null in any month
// the source never published. without this the x axis is an array place, so
// a two month move would be drawn at one month of width
export function historyGrid(history: IndicatorPoint[]): HistoryGrid {
  const slots = new Map<number, number>();
  for (const p of history) {
    const slot = monthSlot(p.date);
    // a point without a readable month cannot be placed, so the whole
    // history falls back to its own order
    if (slot === null) return { dates: history.map((h) => h.date), values: history.map((h) => h.value) };
    slots.set(slot, p.value);
  }
  if (slots.size === 0) return { dates: [], values: [] };
  const keys = [...slots.keys()];
  const first = Math.min(...keys);
  const last = Math.max(...keys);
  const dates: string[] = [];
  const values: (number | null)[] = [];
  for (let slot = first; slot <= last; slot += 1) {
    dates.push(slotDate(slot));
    values.push(slots.has(slot) ? (slots.get(slot) as number) : null);
  }
  return { dates, values };
}

// one line cannot be drawn through a single point, so the tile shows no
// sparkline at all rather than a broken path
export function indicatorSpark(history: IndicatorPoint[], width = SPARK_W, height = SPARK_H, pad = SPARK_PAD): Spark | null {
  if (history.length < 2) return null;
  const spark = buildSparkline(historyGrid(history).values, width, height, pad);
  return spark.points.length < 2 ? null : spark;
}

export interface ChartPoint {
  date: string;
  value: number;
  x: number;
  y: number;
}

export interface IndicatorChartModel {
  width: number;
  height: number;
  d: string;
  points: ChartPoint[];
  last: ChartPoint;
  // the low and high of the history, for the two direct labels
  values: [number, number];
}

// the expanded chart, on the same geometry as the tile sparkline so both
// draw the series the same way
export function buildIndicatorChart(history: IndicatorPoint[], width = CHART_W, height = CHART_H, pad = CHART_PAD): IndicatorChartModel | null {
  const spark = indicatorSpark(history, width, height, pad);
  if (!spark) return null;
  // a spark index is a calendar slot, so the month comes from the grid
  const dates = historyGrid(history).dates;
  const points = spark.points.map((p) => ({ date: dates[p.index], value: p.value, x: p.x, y: p.y }));
  const values = history.map((p) => p.value);
  return {
    width,
    height,
    d: spark.d,
    points,
    last: points[points.length - 1],
    values: [Math.min(...values), Math.max(...values)],
  };
}

// the point nearest a horizontal position, for the crosshair
export function nearestChartPoint(chart: IndicatorChartModel | null, px: number): ChartPoint | null {
  if (!chart || chart.points.length === 0) return null;
  let best = chart.points[0];
  let bestDistance = Math.abs(best.x - px);
  for (const point of chart.points) {
    const distance = Math.abs(point.x - px);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

// the spans the chart can be read at, with the months each keeps. one year
// is the window the tile's twelve month figure covers, five years is what
// the strip has always drawn, and twenty five reaches past 2008 for the
// series that go back that far. nothing longer is fixed, because the start
// dates run from 1962 to 2010 and a named span that no series fills would
// only promise months the sources never published
const RANGE_STEPS = [
  { id: "1y", label: "1y", months: 12 },
  { id: "5y", label: "5y", months: 60 },
  { id: "10y", label: "10y", months: 120 },
  { id: "25y", label: "25y", months: 300 },
];

// the whole history, however deep the build turns out to be
export const MAX_RANGE = "max";

// the span the chart opens at, whenever the series is longer than it
export const DEFAULT_RANGE = "5y";

export interface IndicatorRange {
  id: string;
  label: string;
  // the calendar months the chart keeps, null for the whole history
  months: number | null;
  // the label and the months it really draws, for the button's name
  readout: string;
}

// the last months of a history, counted on the calendar so a month the
// source never published still uses up its place. null keeps the whole run
export function clipHistory(history: IndicatorPoint[], months: number | null): IndicatorPoint[] {
  if (months === null || months < 1 || history.length === 0) return history;
  const slots = history.map((p) => monthSlot(p.date));
  // a month that cannot be read has no calendar place, so the count falls
  // back to the points themselves, the way historyGrid does
  if (slots.some((s) => s === null)) return history.slice(-months);
  const last = Math.max(...(slots as number[]));
  return history.filter((_, i) => (slots[i] as number) > last - months);
}

// the calendar months a history covers, counting the months it is missing,
// so a span is offered only when the series really reaches back that far
export function historySpan(history: IndicatorPoint[]): number {
  return historyGrid(history).dates.length;
}

// the spans this history can be read at, shortest first and always ending
// in the whole run. a span the series cannot fill is left out rather than
// offered and quietly cut short, and one that matches the whole run is left
// out too, so no two buttons draw the same chart
export function indicatorRanges(history: IndicatorPoint[]): IndicatorRange[] {
  const span = historySpan(history);
  if (span < 2) return [];
  const steps = RANGE_STEPS
    .filter((step) => step.months < span)
    .map((step) => ({ step, shown: clipHistory(history, step.months) }))
    .filter(({ shown }) => shown.length > 1)
    .map(({ step, shown }) => ({
      id: step.id,
      label: step.label,
      months: step.months,
      readout: `${step.label}, ${rangeLabel(shown)}`,
    }));
  return [...steps, { id: MAX_RANGE, label: "Max", months: null, readout: `Max, ${rangeLabel(history)}` }];
}

// the span a chart is showing. a chosen span that the series cannot fill
// falls back to the default, so moving to a shorter series never leaves the
// control with nothing pressed
export function activeRangeId(ranges: IndicatorRange[], chosen: string | null): string {
  if (chosen && ranges.some((r) => r.id === chosen)) return chosen;
  return ranges.some((r) => r.id === DEFAULT_RANGE) ? DEFAULT_RANGE : MAX_RANGE;
}

// the months behind a span, and the whole history for anything unknown
export function rangeMonths(ranges: IndicatorRange[], id: string): number | null {
  return ranges.find((r) => r.id === id)?.months ?? null;
}

// the month and the value under the crosshair, "Aug 2026: 2.9%"
export function pointReadout(point: ChartPoint, format: IndicatorFormat): string {
  return `${monthLabel(point.date)}: ${formatValue(point.value, displayFormat(format))}`;
}

// what a tile reads out, as its name and on hover
export function tileReadout(indicator: Indicator): string {
  const when = monthLabel(indicator.date);
  const value = when ? `${indicatorValue(indicator)} in ${when}` : indicatorValue(indicator);
  return `${indicator.label}, ${value}, ${changeChip(indicator.change_12m).label}`;
}

// the chart's own name, with the span it covers. that is the whole history
// unless the chart has been narrowed to a window of it
export function chartTitle(indicator: Indicator, shown: IndicatorPoint[] = indicator.history): string {
  const range = rangeLabel(shown);
  return range ? `${indicator.label}, monthly, ${range}` : indicator.label;
}

// who publishes the series and the whole run of months the build carries,
// under the chart. the chart itself names the window it is drawing
export function sourceLine(indicator: Indicator): string {
  const range = rangeLabel(indicator.history);
  const provider = indicator.provider || "source not named";
  return range ? `${provider}, monthly, ${range}` : provider;
}

// the standalone header stat stays only while no tile carries the rate
export function showMortgageStat(rate: MortgageRate | null, indicators: Indicator[]): boolean {
  return rate !== null && !indicators.some((i) => i.id === MORTGAGE_ID);
}

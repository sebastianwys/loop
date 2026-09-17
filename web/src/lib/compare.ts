import type { AnnualSeries, Metro } from "../types";
import { formatValue } from "./format";
import { niceTicks, yearTicks, type HistoryPoint } from "./history";
import type { LayoutMode } from "./layout";

// two lines are the least that is a comparison, and a fifth would outrun the
// four marks, dashes and colours a reader can hold apart on one chart
export const MIN_COMPARE = 2;
export const MAX_COMPARE = 4;

export type Marker = "circle" | "square" | "triangle" | "diamond";

// each slot carries three encodings, so the chart still reads in grayscale,
// in print, and to a reader who sees no difference between the hues
export const DASHES: string[] = ["", "7 4", "2 3", "10 4 2 4"];
export const MARKERS: Marker[] = ["circle", "square", "triangle", "diamond"];

export interface ChartSize {
  width: number;
  height: number;
  // whether the right gutter is there for the labels drawn at each line's end
  labels: boolean;
}

// the box the chart is drawn in. it is scaled to whatever column it lands in,
// so this is an aspect ratio and a label density rather than a pixel size. a
// phone gets a narrow, tall box and no end labels: the legend names the lines
export function chartSize(mode: LayoutMode): ChartSize {
  switch (mode) {
    case "phone": return { width: 340, height: 230, labels: false };
    case "tablet": return { width: 560, height: 270, labels: true };
    case "compact": return { width: 680, height: 300, labels: true };
    default: return { width: 820, height: 330, labels: true };
  }
}

// the codes the address bar carries, as metros, in the order they were
// chosen. a code this build does not carry is dropped, and the list stops at
// the fourth rather than pushing somebody else's line off the chart
export function chooseMetros(codes: string[], metros: Metro[]): Metro[] {
  const out: Metro[] = [];
  for (const code of codes) {
    if (out.length >= MAX_COMPARE) break;
    const metro = metros.find((m) => m.cbsa === code);
    if (metro && !out.some((m) => m.cbsa === code)) out.push(metro);
  }
  return out;
}

// picking a metro already in the comparison takes it out again. the fifth is
// refused rather than quietly dropping the first
export function toggleCompare(codes: string[], cbsa: string): string[] {
  if (codes.includes(cbsa)) return codes.filter((code) => code !== cbsa);
  return codes.length >= MAX_COMPARE ? codes : [...codes, cbsa];
}

// "Dallas-Fort Worth-Arlington, TX" is not a label that fits at the end of a
// line. the first city named and the state tell four metros apart, and the
// legend and the table carry the whole name
export function shortLabel(name: string): string {
  const [places, ...rest] = name.split(",");
  const city = places.split("-")[0].trim();
  const state = rest.join(",").trim().split(/\s+/)[0] ?? "";
  return state ? `${city}, ${state}` : city;
}

// labels that would sit on top of each other, pushed apart in place. the
// order is kept, so a label never crosses the line above or below it
export function spreadLabels(ys: number[], gap: number, top: number, bottom: number): number[] {
  const items = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  let floor = top;
  for (const item of items) {
    item.y = Math.max(item.y, floor);
    floor = item.y + gap;
  }
  let ceiling = bottom;
  for (let k = items.length - 1; k >= 0; k -= 1) {
    items[k].y = Math.min(items[k].y, ceiling);
    ceiling = items[k].y - gap;
  }
  const out = ys.slice();
  for (const item of items) out[item.i] = item.y;
  return out;
}

// the end marker as one path, so every shape draws through the same element
// and wears the same fill and surface ring
export function markerPath(kind: Marker, x: number, y: number, r: number): string {
  switch (kind) {
    case "square": return `M ${x - r} ${y - r} H ${x + r} V ${y + r} H ${x - r} Z`;
    case "triangle": return `M ${x} ${y - r} L ${x + r} ${y + r} L ${x - r} ${y + r} Z`;
    case "diamond": return `M ${x} ${y - r} L ${x + r} ${y} L ${x} ${y + r} L ${x - r} ${y} Z`;
    default: return `M ${x - r} ${y} A ${r} ${r} 0 1 0 ${x + r} ${y} A ${r} ${r} 0 1 0 ${x - r} ${y} Z`;
  }
}

export interface CompareEntry {
  cbsa: string;
  name: string;
  series: AnnualSeries;
}

export interface CompareLine {
  cbsa: string;
  name: string;
  short: string;
  slot: number;
  dash: string;
  marker: Marker;
  points: HistoryPoint[];
  d: string;
  first: HistoryPoint;
  last: HistoryPoint;
  // where the end label sits after the stack has been pushed apart
  labelY: number;
  // percent from the first year every line has to this line's last point
  growth: number | null;
}

export interface CompareModel {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  lines: CompareLine[];
  // every year on the axis with its x, for the crosshair to land on
  columns: { year: number; x: number }[];
  xTicks: { year: number; x: number }[];
  yTicks: { value: number; y: number }[];
  years: [number, number];
  values: [number, number];
  // the first year every line carries a value, the only honest base for a
  // growth column when the histories start in different years
  shared: number | null;
}

const PAD = { left: 38, right: 14, top: 14, bottom: 22, gutter: 96 };

const r1 = (v: number) => Math.round(v * 10) / 10;

function present(series: AnnualSeries): { year: number; value: number }[] {
  return (series?.values ?? [])
    .map((v, i) => ({ year: series.start + i, value: v }))
    .filter((p): p is { year: number; value: number } => typeof p.value === "number" && Number.isFinite(p.value));
}

// the first year on the axis that every line has a value for
function sharedStart(rows: { year: number }[][]): number | null {
  if (rows.length === 0) return null;
  const from = Math.max(...rows.map((points) => points[0].year));
  const to = Math.min(...rows.map((points) => points[points.length - 1].year));
  for (let year = from; year <= to; year += 1) {
    if (rows.every((points) => points.some((p) => p.year === year))) return year;
  }
  return null;
}

// the overlay. buildHistory fits a scale to the one series it is given, and
// lines drawn on scales of their own would not be a comparison, so the ticks
// come from the same helpers here but over the union of every series
export function buildCompare(entries: CompareEntry[], size: ChartSize): CompareModel {
  const { width, height } = size;
  const left = PAD.left;
  const right = width - (size.labels ? PAD.gutter : PAD.right);
  const top = PAD.top;
  const bottom = height - PAD.bottom;
  const base = { width, height, left, right, top, bottom };
  const rows = entries
    .map((entry) => ({ entry, points: present(entry.series) }))
    .filter((row) => row.points.length > 0)
    .slice(0, MAX_COMPARE);
  if (rows.length === 0) {
    return { ...base, lines: [], columns: [], xTicks: [], yTicks: [], years: [0, 0], values: [0, 0], shared: null };
  }

  const years: [number, number] = [
    Math.min(...rows.map((row) => row.points[0].year)),
    Math.max(...rows.map((row) => row.points[row.points.length - 1].year)),
  ];
  const all = rows.flatMap((row) => row.points.map((p) => p.value));
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const values: [number, number] = [ticks[0], ticks[ticks.length - 1]];
  const x = (year: number) =>
    r1(years[1] === years[0] ? (left + right) / 2 : left + ((year - years[0]) * (right - left)) / (years[1] - years[0]));
  const y = (v: number) => r1(bottom - ((v - values[0]) * (bottom - top)) / (values[1] - values[0]));

  const shared = sharedStart(rows.map((row) => row.points));
  const lines: CompareLine[] = rows.map((row, slot) => {
    const points: HistoryPoint[] = row.points.map((p) => ({ ...p, x: x(p.year), y: y(p.value) }));
    // the same gap rule the single metro chart draws by: a segment only joins
    // consecutive years, so a hole in a history is a hole in the line. a year
    // with a hole on either side of it is a zero length segment, which the
    // round cap draws as a dot rather than losing the value altogether
    let d = "";
    points.forEach((p, k) => {
      const prev = points[k - 1];
      const next = points[k + 1];
      const joined = prev && p.year === prev.year + 1;
      const joins = next && next.year === p.year + 1;
      if (joined) d += ` L ${p.x} ${p.y}`;
      else if (joins) d += ` M ${p.x} ${p.y}`;
      else d += ` M ${p.x} ${p.y} L ${p.x} ${p.y}`;
    });
    const first = points[0];
    const last = points[points.length - 1];
    const at = shared === null ? null : points.find((p) => p.year === shared) ?? null;
    return {
      cbsa: row.entry.cbsa,
      name: row.entry.name,
      short: shortLabel(row.entry.name),
      slot,
      dash: DASHES[slot],
      marker: MARKERS[slot],
      points,
      d: d.trim(),
      first,
      last,
      labelY: last.y,
      growth: at && at.value > 0 ? (last.value / at.value - 1) * 100 : null,
    };
  });

  const spread = spreadLabels(lines.map((line) => line.last.y), 13, top + 4, bottom);
  lines.forEach((line, i) => { line.labelY = spread[i]; });

  const columns: { year: number; x: number }[] = [];
  for (let year = years[0]; year <= years[1]; year += 1) columns.push({ year, x: x(year) });

  return {
    ...base,
    lines,
    columns,
    xTicks: yearTicks(years[0], years[1], size.labels ? 8 : 5).map((year) => ({ year, x: x(year) })),
    yTicks: ticks.map((value) => ({ value, y: y(value) })),
    years,
    values,
    shared,
  };
}

// the year nearest a horizontal position, for the crosshair
export function nearestYear(model: CompareModel, px: number): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const column of model.columns) {
    const distance = Math.abs(column.x - px);
    if (distance < bestDistance) {
      best = column.year;
      bestDistance = distance;
    }
  }
  return best;
}

export function columnX(model: CompareModel, year: number): number | null {
  return model.columns.find((column) => column.year === year)?.x ?? null;
}

export interface Reading {
  cbsa: string;
  short: string;
  slot: number;
  dash: string;
  marker: Marker;
  point: HistoryPoint | null;
}

// every line read at one year, in the order they were chosen. a line with no
// value that year reads null rather than being left out of the row
export function readingAt(model: CompareModel, year: number): Reading[] {
  return model.lines.map((line) => ({
    cbsa: line.cbsa,
    short: line.short,
    slot: line.slot,
    dash: line.dash,
    marker: line.marker,
    point: line.points.find((p) => p.year === year) ?? null,
  }));
}

// what a screen reader is given in place of the chart, and the title the
// pointer finds: every line named, with where it started and where it ended
export function compareTitle(model: CompareModel): string {
  if (model.lines.length === 0) return "no house price history to compare";
  const each = model.lines
    .map((line) => `${line.name}, ${formatValue(line.first.value, "index")} in ${line.first.year} to ${formatValue(line.last.value, "index")} in ${line.last.year}`)
    .join("; ");
  return `house price index, ${model.years[0]} to ${model.years[1]}. ${each}`;
}

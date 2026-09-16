import type { AnnualSeries, Metro } from "../types";
import { fieldAt } from "./metrics";

export interface HistoryPoint {
  year: number;
  value: number;
  x: number;
  y: number;
}

// an expected level one or two years past the last point, with its band
// edges when the export carried both
export interface ForecastPoint extends HistoryPoint {
  lo: number | null;
  hi: number | null;
  yLo: number | null;
  yHi: number | null;
}

// the model's growth figures in percent, as the export writes them
export interface ForecastInput {
  mid4: number | null;
  mid8: number | null;
  lo4: number | null;
  hi4: number | null;
  lo8: number | null;
  hi8: number | null;
}

export interface Level {
  year: number;
  mid: number;
  lo: number | null;
  hi: number | null;
}

export interface History {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  points: HistoryPoint[];
  d: string;
  last: HistoryPoint | null;
  forecast: ForecastPoint[];
  forecastD: string;
  bandD: string;
  xTicks: { year: number; x: number }[];
  yTicks: { value: number; y: number }[];
  years: [number, number];
  values: [number, number];
}

const PAD = { left: 36, right: 12, top: 14, bottom: 18 };

const r1 = (v: number) => Math.round(v * 10) / 10;

const grow = (level: number, pct: number | null) => (pct === null ? null : level * (1 + pct / 100));

// the forecast fields of a metro, null when the model wrote no point
export function forecastOf(metro: Metro): ForecastInput | null {
  const f: ForecastInput = {
    mid4: fieldAt(metro, "latest", "hpi_forecast_4q"),
    mid8: fieldAt(metro, "latest", "hpi_forecast_8q"),
    lo4: fieldAt(metro, "latest", "hpi_forecast_4q_lo"),
    hi4: fieldAt(metro, "latest", "hpi_forecast_4q_hi"),
    lo8: fieldAt(metro, "latest", "hpi_forecast_8q_lo"),
    hi8: fieldAt(metro, "latest", "hpi_forecast_8q_hi"),
  };
  return f.mid4 === null && f.mid8 === null ? null : f;
}

// the expected levels: the last level grown by each percent, one year out
// for the four quarter figure and two for the eight. a year without a
// median is left out; band edges come only in pairs
export function forecastLevels(last: { year: number; value: number }, f: ForecastInput | null): Level[] {
  if (!f) return [];
  const levels: Level[] = [];
  const steps: [number, number | null, number | null, number | null][] = [
    [1, f.mid4, f.lo4, f.hi4],
    [2, f.mid8, f.lo8, f.hi8],
  ];
  for (const [ahead, mid, lo, hi] of steps) {
    const level = grow(last.value, mid);
    if (level === null) continue;
    const paired = lo !== null && hi !== null;
    levels.push({ year: last.year + ahead, mid: level, lo: paired ? grow(last.value, lo) : null, hi: paired ? grow(last.value, hi) : null });
  }
  return levels;
}

// round values that bracket the data, about count steps apart
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min - 1, min, min + 1];
  const raw = (max - min) / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

// whole years at the coarsest step that fits within the tick budget
export function yearTicks(from: number, to: number, max = 8): number[] {
  if (to < from) return [];
  const step = [1, 2, 3, 5, 10].find((s) => Math.floor(to / s) - Math.ceil(from / s) + 1 <= max) ?? 10;
  const ticks: number[] = [];
  for (let y = Math.ceil(from / step) * step; y <= to; y += step) ticks.push(y);
  return ticks;
}

// the plot: the history as a line, gaps at nulls, the last point marked,
// and the expected path with its band when the model carries one
export function buildHistory(series: AnnualSeries, forecast: ForecastInput | null, width = 320, height = 140): History {
  const left = PAD.left;
  const right = width - PAD.right;
  const top = PAD.top;
  const bottom = height - PAD.bottom;
  const empty: History = {
    width, height, left, right, top, bottom,
    points: [], d: "", last: null, forecast: [], forecastD: "", bandD: "",
    xTicks: [], yTicks: [], years: [series.start, series.start], values: [0, 0],
  };

  const present = series.values
    .map((v, i) => ({ year: series.start + i, value: v }))
    .filter((p): p is { year: number; value: number } => typeof p.value === "number" && Number.isFinite(p.value));
  if (present.length === 0) return empty;

  const lastPresent = present[present.length - 1];
  // the model measured its percents from the as_of quarter's level, which for
  // a partial last year is not that year's mean, so grow from the anchor
  const base = typeof series.anchor === "number" && Number.isFinite(series.anchor) ? series.anchor : lastPresent.value;
  const levels = forecastLevels({ year: lastPresent.year, value: base }, forecast);
  const lastYear = series.start + series.values.length - 1;
  const years: [number, number] = [series.start, Math.max(lastYear, ...levels.map((l) => l.year))];

  const all = present.map((p) => p.value);
  for (const l of levels) all.push(l.mid, ...(l.lo !== null && l.hi !== null ? [l.lo, l.hi] : []));
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const values: [number, number] = [ticks[0], ticks[ticks.length - 1]];

  const x = (year: number) => r1(years[1] === years[0] ? (left + right) / 2 : left + ((year - years[0]) * (right - left)) / (years[1] - years[0]));
  const y = (v: number) => r1(bottom - ((v - values[0]) * (bottom - top)) / (values[1] - values[0]));

  const points: HistoryPoint[] = present.map((p) => ({ ...p, x: x(p.year), y: y(p.value) }));
  let d = "";
  points.forEach((p, k) => {
    const prev = points[k - 1];
    const next = points[k + 1];
    if (prev && p.year === prev.year + 1) d += ` L ${p.x} ${p.y}`;
    else if (next && next.year === p.year + 1) d += ` M ${p.x} ${p.y}`;
  });
  const last = points[points.length - 1];

  const fc: ForecastPoint[] = levels.map((l) => ({
    year: l.year, value: l.mid, x: x(l.year), y: y(l.mid),
    lo: l.lo, hi: l.hi, yLo: l.lo === null ? null : y(l.lo), yHi: l.hi === null ? null : y(l.hi),
  }));
  const forecastD = fc.length ? [`M ${last.x} ${last.y}`, ...fc.map((p) => `L ${p.x} ${p.y}`)].join(" ") : "";
  const banded = fc.filter((p) => p.yLo !== null && p.yHi !== null);
  const bandD = banded.length
    ? [`M ${last.x} ${last.y}`, ...banded.map((p) => `L ${p.x} ${p.yHi}`), ...[...banded].reverse().map((p) => `L ${p.x} ${p.yLo}`), "Z"].join(" ")
    : "";

  return {
    width, height, left, right, top, bottom,
    points, d: d.trim(), last, forecast: fc, forecastD, bandD,
    xTicks: yearTicks(years[0], years[1]).map((year) => ({ year, x: x(year) })),
    yTicks: ticks.map((value) => ({ value, y: y(value) })),
    years, values,
  };
}

export type Hovered = { kind: "history"; point: HistoryPoint } | { kind: "forecast"; point: ForecastPoint };

// the point nearest a horizontal position, history or forecast
export function nearestPoint(history: History, px: number): Hovered | null {
  let best: Hovered | null = null;
  let bestDistance = Infinity;
  for (const point of history.points) {
    const distance = Math.abs(point.x - px);
    if (distance < bestDistance) {
      best = { kind: "history", point };
      bestDistance = distance;
    }
  }
  for (const point of history.forecast) {
    const distance = Math.abs(point.x - px);
    if (distance < bestDistance) {
      best = { kind: "forecast", point };
      bestDistance = distance;
    }
  }
  return best;
}

// every hoverable point in year order, for stepping with the keyboard
export function hoverables(history: History): Hovered[] {
  return [
    ...history.points.map((point): Hovered => ({ kind: "history", point })),
    ...history.forecast.map((point): Hovered => ({ kind: "forecast", point })),
  ];
}

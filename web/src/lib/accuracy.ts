import { niceTicks } from "./history";
import type { LayoutMode } from "./layout";
import { dateAt, fieldAt } from "./metrics";
import type { RouteState } from "./route";
import type { Metro } from "../types";

// the model's own scorecard. hpi_surprise_4q is realized four quarter growth
// to the origin minus the median the model published for that window four
// quarters earlier, in percentage points, built from test block rows only.
// everything on this page is read off that one field

// a normal curve leaves this share of its mass beyond two standard
// deviations, which is what the observed tail is worth comparing against
export const NORMAL_TAIL = 0.0455;

export interface Miss {
  cbsa: string;
  name: string;
  state: string;
  // realized growth over the scored window, percent. the export derived the
  // surprise from it, so it is present whenever the surprise is, but a build
  // that carried one without the other still has to render
  realized: number | null;
  // what the model said, backed out of the two: realized minus the surprise
  expected: number | null;
  // realized minus expected. positive means the metro grew more than the
  // model expected
  surprise: number;
  // fhfa's standard error for the index, as a percent of the index
  error: number | null;
  // the population estimate, for checking whether the index error is really
  // just a measure of how small a metro is
  pop: number | null;
}

// the postal code at the end of a metro name. "Paducah, KY-IL" is filed
// under the first state named, which is where the metro's core sits
export function stateOf(name: string): string {
  const parts = name.split(",");
  if (parts.length < 2) return "";
  return parts[parts.length - 1].trim().split(/[\s-]/)[0] ?? "";
}

// a metro counts only when it carries a surprise. a null is a call that was
// never scored, not a call the model got exactly right, so it is dropped
// here rather than sliding into the arithmetic as a zero
export function collectMisses(metros: Metro[]): Miss[] {
  const out: Miss[] = [];
  for (const metro of metros) {
    const surprise = fieldAt(metro, "latest", "hpi_surprise_4q");
    if (surprise === null) continue;
    const realized = fieldAt(metro, "latest", "hpi_yoy_latest");
    out.push({
      cbsa: metro.cbsa,
      name: metro.name,
      state: stateOf(metro.name),
      realized,
      expected: realized === null ? null : realized - surprise,
      surprise,
      error: fieldAt(metro, "latest", "hpi_index_error"),
      pop: fieldAt(metro, "latest", "pop_estimate"),
    });
  }
  return out;
}

export interface Coverage {
  metros: number;
  scored: number;
  unscored: number;
  // divisions are the pieces fhfa publishes inside the largest metros, so a
  // few big places are scored twice, once whole and once in parts
  divisions: number;
  // metros scored but carrying no index standard error to plot against
  withError: number;
}

export function coverage(metros: Metro[], misses: Miss[]): Coverage {
  const scored = new Set(misses.map((m) => m.cbsa));
  return {
    metros: metros.length,
    scored: misses.length,
    unscored: metros.length - misses.length,
    divisions: metros.filter((m) => m.level === "division" && scored.has(m.cbsa)).length,
    withError: misses.filter((m) => m.error !== null).length,
  };
}

// picking a metro here opens it on the map, the way every other view hands a
// metro over. changing the view is a destination, so the back button comes
// straight back to this page
export function openMetro(cbsa: string): Pick<RouteState, "view" | "metro"> {
  return { view: "map", metro: cbsa };
}

// the origin quarter the scored calls were made against, as the export dated
// them. the newest any metro carries is the one the whole page is as of
export function originOf(metros: Metro[]): string | null {
  let newest: string | null = null;
  for (const metro of metros) {
    const date = dateAt(metro, "latest", "hpi_surprise_4q");
    if (date !== null && (newest === null || date > newest)) newest = date;
  }
  return newest;
}

// linear interpolation between order statistics, the same rule scale.ts bins by
export function quantileOf(sorted: number[], p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface Summary {
  n: number;
  mean: number;
  median: number;
  sd: number;
  mae: number;
  rmse: number;
  q1: number;
  q3: number;
  p05: number;
  p95: number;
  min: number;
  max: number;
  skew: number;
  // excess kurtosis: zero for a normal curve, positive for fatter tails
  kurtosis: number;
  // share of metros that grew less than the model expected, 0 to 1
  high: number;
  // share sitting more than two standard deviations from the mean
  outliers: number;
  // the textbook standard error of the mean, which assumes 410 independent
  // draws. stateSpread below is the reason not to believe it
  se: number;
}

export function summarize(misses: Miss[]): Summary | null {
  const n = misses.length;
  if (n === 0) return null;
  const values = misses.map((m) => m.surprise);
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  // one metro is a centre with no spread, so the shape figures have nothing
  // to divide by and read as zero rather than as a NaN on the page
  const squares = values.reduce((a, b) => a + (b - mean) ** 2, 0);
  const sd = n > 1 ? Math.sqrt(squares / (n - 1)) : 0;
  // the shape figures are moment ratios, which take the population spread
  // rather than the n minus one one reported beside them
  const spread = Math.sqrt(squares / n);
  const moment = (power: number) => (spread === 0 ? 0 : values.reduce((a, b) => a + ((b - mean) / spread) ** power, 0) / n);
  const fourth = moment(4);
  return {
    n,
    mean,
    median: quantileOf(sorted, 0.5),
    sd,
    mae: values.reduce((a, b) => a + Math.abs(b), 0) / n,
    rmse: Math.sqrt(values.reduce((a, b) => a + b * b, 0) / n),
    q1: quantileOf(sorted, 0.25),
    q3: quantileOf(sorted, 0.75),
    p05: quantileOf(sorted, 0.05),
    p95: quantileOf(sorted, 0.95),
    min: sorted[0],
    max: sorted[n - 1],
    skew: moment(3),
    kurtosis: fourth === 0 ? 0 : fourth - 3,
    high: values.filter((v) => v < 0).length / n,
    outliers: sd === 0 ? 0 : values.filter((v) => Math.abs(v - mean) > 2 * sd).length / n,
    se: sd / Math.sqrt(n),
  };
}

export interface Extremes {
  // metros that grew more than the model expected, biggest gap first
  above: Miss[];
  // and the ones that grew less
  below: Miss[];
}

// the biggest miss in each direction, named, so a reader can check the
// arithmetic against the two numbers beside it. each list is filtered by the
// sign it claims, or a lopsided year puts metros the model overshot under a
// heading saying they beat it
export function extremes(misses: Miss[], count: number): Extremes {
  const take = Math.max(0, count);
  return {
    above: misses.filter((m) => m.surprise > 0).sort((a, b) => b.surprise - a.surprise).slice(0, take),
    below: misses.filter((m) => m.surprise < 0).sort((a, b) => a.surprise - b.surprise).slice(0, take),
  };
}

export interface StateGroup {
  state: string;
  n: number;
  mean: number;
}

export interface StateSpread {
  groups: StateGroup[];
  // of the states big enough to read, how many missed the same way the
  // country did. a national cycle shows up as nearly all of them
  agreeing: number;
  // the share of the variation in the miss that sits between states rather
  // than within them
  between: number;
  // the standard error of the mean with states as clusters, beside the naive
  // one. clustering is the cheap way to say metros are not independent
  clusterSe: number;
}

// the fewest metros a state needs before its mean is worth printing
export const MIN_STATE = 5;

export function stateSpread(misses: Miss[], min = MIN_STATE): StateSpread | null {
  const n = misses.length;
  if (n === 0) return null;
  const by = new Map<string, number[]>();
  for (const miss of misses) {
    const list = by.get(miss.state);
    if (list) list.push(miss.surprise);
    else by.set(miss.state, [miss.surprise]);
  }
  const mean = misses.reduce((a, m) => a + m.surprise, 0) / n;

  let within = 0;
  let clustered = 0;
  for (const values of by.values()) {
    const groupMean = values.reduce((a, b) => a + b, 0) / values.length;
    for (const v of values) within += (v - groupMean) ** 2;
    clustered += values.reduce((a, b) => a + (b - mean), 0) ** 2;
  }
  const total = misses.reduce((a, m) => a + (m.surprise - mean) ** 2, 0);

  const groups = [...by.entries()]
    .filter(([, values]) => values.length >= min)
    .map(([state, values]) => ({ state, n: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length }))
    .sort((a, b) => a.mean - b.mean);

  return {
    groups,
    agreeing: groups.filter((g) => (mean < 0 ? g.mean < 0 : g.mean > 0)).length,
    between: total === 0 ? 0 : 1 - within / total,
    clusterSe: Math.sqrt(clustered) / n,
  };
}

export interface Fit {
  n: number;
  slope: number;
  intercept: number;
  r: number;
  // the share of the variation in the miss this line accounts for. it is not
  // a share the index error causes, and it is not a forecast of anything
  r2: number;
  // the same association on ranks, where one loose metro cannot make the line.
  // null when the ranks are degenerate and there is nothing to correlate
  rho: number | null;
  seSlope: number;
  // slope over its standard error. null when the points sit exactly on the
  // line, where the ratio is not a number rather than a very confident one
  t: number | null;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

// average ranks, so a run of equal values does not order itself by accident
export function ranksOf(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[order[k][1]] = rank;
    i = j + 1;
  }
  return out;
}

// least squares through the pairs. it is a line drawn through a cloud, not a
// mechanism: nothing here says a loose index makes a metro hard to forecast
export function fitLine(xs: number[], ys: number[]): Fit | null {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const r = pearson(xs, ys);
  if (r === null) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let residual = 0;
  for (let i = 0; i < n; i += 1) residual += (ys[i] - (intercept + slope * xs[i])) ** 2;
  const seSlope = n > 2 ? Math.sqrt(residual / (n - 2)) / Math.sqrt(sxx) : 0;
  return {
    n,
    slope,
    intercept,
    r,
    r2: r * r,
    rho: pearson(ranksOf(xs), ranksOf(ys)),
    seSlope,
    t: seSlope === 0 ? null : slope / seSlope,
  };
}

// how tied the index error is to metro size. a loose index and a hard to
// forecast market may both be small market, and this is the number that says
// how much of the error is standing in for population rather than for noise
export function sizeFit(misses: Miss[]): Fit | null {
  const rows = misses.filter((m) => m.error !== null && m.pop !== null && (m.pop as number) > 0);
  return fitLine(rows.map((m) => Math.log(m.pop as number)), rows.map((m) => m.error as number));
}

export interface ErrorBin {
  from: number;
  to: number;
  n: number;
  // the typical size of the miss in this band, ignoring its direction
  meanAbs: number;
  // and its direction, which is a different question
  meanSigned: number;
}

// equal sized groups of metros ordered by how loosely their index is
// measured. a scatter of 410 dots hides whether the middle moves at all,
// and these bins are the part of it a reader can check in a table
export function errorBins(misses: Miss[], count = 4): ErrorBin[] {
  const rows = misses.filter((m) => m.error !== null).sort((a, b) => (a.error as number) - (b.error as number));
  if (rows.length < count) return [];
  const per = Math.floor(rows.length / count);
  const bins: ErrorBin[] = [];
  for (let k = 0; k < count; k += 1) {
    const part = k === count - 1 ? rows.slice(k * per) : rows.slice(k * per, (k + 1) * per);
    bins.push({
      from: part[0].error as number,
      to: part[part.length - 1].error as number,
      n: part.length,
      meanAbs: part.reduce((a, m) => a + Math.abs(m.surprise), 0) / part.length,
      meanSigned: part.reduce((a, m) => a + m.surprise, 0) / part.length,
    });
  }
  return bins;
}

export interface Stance {
  n: number;
  median: number;
  q1: number;
  q3: number;
  min: number;
  max: number;
  median8: number | null;
  // the published 90 percent band on the four quarter call, in percentage
  // points from edge to edge. the narrowest and widest say whether the model
  // widens the band per metro or hands out one width to everybody
  bandWidth: number | null;
  bandMin: number | null;
  bandMax: number | null;
  bandN: number;
}

// what the model is saying now, across every metro that carries a live call
export function stance(metros: Metro[]): Stance | null {
  const points: number[] = [];
  const eight: number[] = [];
  const widths: number[] = [];
  for (const metro of metros) {
    const mid = fieldAt(metro, "latest", "hpi_forecast_4q");
    if (mid !== null) points.push(mid);
    const mid8 = fieldAt(metro, "latest", "hpi_forecast_8q");
    if (mid8 !== null) eight.push(mid8);
    const lo = fieldAt(metro, "latest", "hpi_forecast_4q_lo");
    const hi = fieldAt(metro, "latest", "hpi_forecast_4q_hi");
    if (lo !== null && hi !== null) widths.push(hi - lo);
  }
  if (points.length === 0) return null;
  const sorted = points.sort((a, b) => a - b);
  const sorted8 = eight.sort((a, b) => a - b);
  const sortedW = widths.sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: quantileOf(sorted, 0.5),
    q1: quantileOf(sorted, 0.25),
    q3: quantileOf(sorted, 0.75),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median8: sorted8.length ? quantileOf(sorted8, 0.5) : null,
    bandWidth: sortedW.length ? quantileOf(sortedW, 0.5) : null,
    bandMin: sortedW.length ? sortedW[0] : null,
    bandMax: sortedW.length ? sortedW[sortedW.length - 1] : null,
    bandN: sortedW.length,
  };
}

export interface Box {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ChartBox {
  width: number;
  height: number;
  // the bin width of the histogram in percentage points. a phone has no room
  // for twenty bars, so it reads the same distribution at half the resolution
  step: number;
}

export function chartBox(mode: LayoutMode): ChartBox {
  switch (mode) {
    case "phone": return { width: 340, height: 220, step: 2 };
    case "tablet": return { width: 560, height: 250, step: 1 };
    case "compact": return { width: 680, height: 270, step: 1 };
    default: return { width: 820, height: 290, step: 1 };
  }
}

const PAD = { left: 34, right: 12, top: 16, bottom: 34 };

function box(width: number, height: number): Box {
  return { width, height, left: PAD.left, right: width - PAD.right, top: PAD.top, bottom: height - PAD.bottom };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export interface HistogramBar {
  from: number;
  to: number;
  count: number;
  x: number;
  y: number;
  w: number;
  h: number;
  // which way the model missed in this bar. position on the axis already
  // says it, so the colour that follows is never the only thing that does
  side: "over" | "under";
}

export interface Histogram extends Box {
  bars: HistogramBar[];
  step: number;
  zeroX: number;
  meanX: number | null;
  medianX: number | null;
  xTicks: { value: number; x: number }[];
  yTicks: { value: number; y: number }[];
  domain: [number, number];
  peak: number;
}

// counts in fixed width bins, with the edges snapped to whole steps so the
// zero line lands on a bin edge and no bar straddles it
export function buildHistogram(misses: Miss[], width: number, height: number, step = 1): Histogram {
  const base = box(width, height);
  const empty: Histogram = {
    ...base, bars: [], step, zeroX: base.left, meanX: null, medianX: null,
    xTicks: [], yTicks: [], domain: [0, 0], peak: 0,
  };
  const values = misses.map((m) => m.surprise);
  if (values.length === 0 || step <= 0) return empty;

  const max = Math.max(...values);
  const lo = Math.min(0, Math.floor(Math.min(...values) / step) * step);
  // bins are closed on the left, so a value sitting exactly on the top edge
  // would be counted in the bar below it and read as smaller than it is
  const edge = Math.ceil(max / step) * step;
  const hi = Math.max(0, edge === max ? edge + step : edge);
  const domain: [number, number] = lo === hi ? [lo - step, hi + step] : [lo, hi];
  const count = Math.round((domain[1] - domain[0]) / step);
  const counts = new Array<number>(count).fill(0);
  for (const v of values) {
    const at = Math.min(count - 1, Math.max(0, Math.floor((v - domain[0]) / step)));
    counts[at] += 1;
  }
  const peak = Math.max(...counts);
  const ticks = niceTicks(0, peak, 4).filter((t) => t >= 0);
  const top = ticks[ticks.length - 1] || peak || 1;

  const x = (v: number) => r1(base.left + ((v - domain[0]) * (base.right - base.left)) / (domain[1] - domain[0]));
  const y = (v: number) => r1(base.bottom - (v * (base.bottom - base.top)) / top);

  // a 2px gutter between bars, so two full bars never read as one wide one
  const bars: HistogramBar[] = counts.map((n, i) => {
    const from = domain[0] + i * step;
    const to = from + step;
    const x0 = x(from);
    const x1 = x(to);
    return {
      from, to, count: n,
      x: x0 + 1, y: y(n), w: Math.max(1, x1 - x0 - 2), h: r1(base.bottom - y(n)),
      side: to <= 0 ? "over" : "under",
    };
  });

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    ...base,
    bars,
    step,
    zeroX: x(0),
    meanX: x(mean),
    medianX: x(quantileOf(sorted, 0.5)),
    xTicks: niceTicks(domain[0], domain[1], 6).filter((t) => t >= domain[0] && t <= domain[1]).map((value) => ({ value, x: x(value) })),
    yTicks: ticks.map((value) => ({ value, y: y(value) })),
    domain,
    peak,
  };
}

// the bin a horizontal position falls in, for the readout under the chart
export function barAt(histogram: Histogram, px: number): HistogramBar | null {
  return histogram.bars.find((bar) => px >= bar.x - 1 && px < bar.x + bar.w + 1) ?? null;
}

export interface ScatterPoint {
  cbsa: string;
  name: string;
  error: number;
  miss: number;
  x: number;
  y: number;
}

export interface BinMark extends ErrorBin {
  x: number;
  y: number;
}

export interface Scatter extends Box {
  points: ScatterPoint[];
  fit: Fit | null;
  // the fitted line clipped to the plot, empty when there is no fit
  fitD: string;
  marks: BinMark[];
  xTicks: { value: number; x: number }[];
  yTicks: { value: number; y: number }[];
  xDomain: [number, number];
  yDomain: [number, number];
}

// how loosely the index is measured against how far the call missed, in
// absolute percentage points. the binned means ride on top because 410 dots
// do not show whether the middle of the cloud moves
export function buildScatter(misses: Miss[], width: number, height: number): Scatter {
  const base = box(width, height);
  const rows = misses.filter((m) => m.error !== null);
  const empty: Scatter = {
    ...base, points: [], fit: null, fitD: "", marks: [],
    xTicks: [], yTicks: [], xDomain: [0, 0], yDomain: [0, 0],
  };
  if (rows.length === 0) return empty;

  const xs = rows.map((m) => m.error as number);
  const ys = rows.map((m) => Math.abs(m.surprise));
  // six steps rather than four, or a single far out metro rounds the top of
  // the axis up past it and leaves a fifth of the plot empty
  const xTicks = niceTicks(0, Math.max(...xs), 6);
  const yTicks = niceTicks(0, Math.max(...ys), 6);
  const xDomain: [number, number] = [0, xTicks[xTicks.length - 1] || 1];
  const yDomain: [number, number] = [0, yTicks[yTicks.length - 1] || 1];

  const x = (v: number) => r1(base.left + ((v - xDomain[0]) * (base.right - base.left)) / (xDomain[1] - xDomain[0]));
  const y = (v: number) => r1(base.bottom - ((v - yDomain[0]) * (base.bottom - base.top)) / (yDomain[1] - yDomain[0]));

  const fit = fitLine(xs, ys);
  const at = (v: number) => (fit === null ? 0 : fit.intercept + fit.slope * v);
  const bins = errorBins(rows);

  return {
    ...base,
    points: rows.map((m, i) => ({ cbsa: m.cbsa, name: m.name, error: xs[i], miss: ys[i], x: x(xs[i]), y: y(ys[i]) })),
    fit,
    fitD: fit === null ? "" : `M ${x(xDomain[0])} ${y(at(xDomain[0]))} L ${x(xDomain[1])} ${y(at(xDomain[1]))}`,
    marks: bins.map((bin) => ({ ...bin, x: x((bin.from + bin.to) / 2), y: y(bin.meanAbs) })),
    xTicks: xTicks.map((value) => ({ value, x: x(value) })),
    yTicks: yTicks.map((value) => ({ value, y: y(value) })),
    xDomain,
    yDomain,
  };
}

// the dot under the pointer, or under the arrow keys. null when the plot is
// empty, so the readout has something definite to say either way
export function nearestMetro(scatter: Scatter, px: number, py: number): ScatterPoint | null {
  let best: ScatterPoint | null = null;
  let bestDistance = Infinity;
  for (const point of scatter.points) {
    const distance = (point.x - px) ** 2 + (point.y - py) ** 2;
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

// what a reader who cannot see the histogram is told instead
export function histogramTitle(summary: Summary | null): string {
  if (summary === null) return "no scored forecasts to chart";
  const way = summary.median < 0 ? "below" : "above";
  return `how far the model's last scored call missed in each of ${summary.n} metros, in percentage points. `
    + `the middle metro came in ${Math.abs(summary.median).toFixed(1)} points ${way} what the model expected, `
    + `and the middle half of metros fall between ${summary.q1.toFixed(1)} and ${summary.q3.toFixed(1)}.`;
}

export function scatterTitle(scatter: Scatter): string {
  if (scatter.points.length === 0) return "no index standard errors to chart";
  const fit = scatter.fit;
  const line = fit === null
    ? "too few metros to fit a line"
    : `the fitted line rises ${fit.slope.toFixed(2)} points of miss per point of index error and accounts for ${(fit.r2 * 100).toFixed(0)} percent of the spread`;
  return `the size of the miss against fhfa's standard error for the index, ${scatter.points.length} metros. ${line}.`;
}

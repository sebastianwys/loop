import type { Metro } from "../types";
import { shortLabel } from "./compare";
import { formatTick, labelWidth } from "./format";
import { niceTicks } from "./history";
import type { LayoutMode } from "./layout";
import { isInherited, withheldBecause, withheldWhy, type Metric, type Withheld } from "./metrics";

// a line through four dots is a drawing, not a finding
export const MIN_FIT = 5;

// how lopsided a metric has to be before a linear axis stops being readable.
// the 95th over the 5th percentile rather than max over median, so one outlier
// cannot flip an axis on its own. population, permits, listings and personal
// income all clear it. prices, rents, rates and shares do not
export const SKEW = 12;

// how far off a dot the pointer can be and still land on it. 410 dots at three
// pixels each would otherwise be unhittable on a phone
export const REACH = 18;

export type AxisScale = "linear" | "log";
export type FitWhy = "ok" | "few" | "flat" | "empty";

export interface PlotSize {
  width: number;
  height: number;
  radius: number;
}

export interface AxisTick {
  value: number;
  pos: number;
  // the tick as printed. buildAxis leaves it empty, the plot fills it in
  label?: string;
}

export interface Axis {
  scale: AxisScale;
  lo: number;
  hi: number;
  ticks: AxisTick[];
  // a value in its own units, placed in pixels
  at: (value: number) => number;
  // a value already through the axis transform, placed in pixels. the fitted
  // line is solved in transformed space, so it needs the second door
  place: (t: number) => number;
}

export interface ExplorePoint {
  cbsa: string;
  name: string;
  short: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
  // either number belongs to this metro's parent metro, not to this metro
  inherited: boolean;
}

export interface ExploreFit {
  slope: number;
  intercept: number;
  r: number;
  r2: number;
  // spearman, which is what survives a skewed metric and a stray outlier
  rho: number | null;
  n: number;
  d: string;
}

export interface ExploreCounts {
  total: number;
  plotted: number;
  inherited: number;
  fitted: number;
  missingX: number;
  missingY: number;
  missing: number;
  // of the missing on each axis, how many the build withheld rather than
  // nobody measuring them, and why. optional so a count built by hand reads
  // as none withheld
  withheldX?: number;
  withheldY?: number;
  whyX?: Withheld | null;
  whyY?: Withheld | null;
}

export interface ExploreModel {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  radius: number;
  points: ExplorePoint[];
  x: Axis;
  y: Axis;
  // every nth x label is printed, so a narrow plot does not run them together
  xEvery: number;
  fit: ExploreFit | null;
  fitWhy: FitWhy;
  counts: ExploreCounts;
}

// the least room each side keeps. left and right grow to fit the tick labels
const PAD = { left: 36, right: 16, top: 16, bottom: 32 };

// the margin a logarithmic axis keeps at each end, as a share of its span,
// so a dot at the extreme is not half outside the box
const PAD_LOG = 0.03;

const r1 = (v: number) => Math.round(v * 10) / 10;

// floating point leaves 3 * 10^-1 as 0.30000000000000004, which reads badly
// as a tick and worse as a key
const tidy = (v: number) => Number(v.toPrecision(12));

// the box the plot is drawn in, an aspect ratio rather than a pixel size. a
// phone gets a shorter box and smaller dots, since the same 410 dots have to
// fit in a third of the width
export function plotSize(mode: LayoutMode): PlotSize {
  switch (mode) {
    case "phone": return { width: 340, height: 300, radius: 2.6 };
    case "tablet": return { width: 520, height: 380, radius: 3 };
    case "compact": return { width: 620, height: 430, radius: 3.2 };
    default: return { width: 700, height: 470, radius: 3.4 };
  }
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// a metric that spans orders of magnitude wastes a linear axis: every metro
// but the largest half dozen lands in one corner. logs are only available to
// a metric that is positive everywhere, which rules out every net figure
export function wantsLog(values: number[]): boolean {
  if (values.length < 8) return false;
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) return false;
  const sorted = [...values].sort((a, b) => a - b);
  const low = quantile(sorted, 0.05);
  return low > 0 && quantile(sorted, 0.95) / low >= SKEW;
}

// round numbers inside the domain, subdivided only while there are few enough
// decades for the labels to fit. the domain ends are not labelled, because a
// padded end is not a number anybody wants to read
export function logTicks(lo: number, hi: number): number[] {
  const decades = Math.log10(hi / lo);
  const steps = decades >= 4 ? [1] : decades >= 1.6 ? [1, 3] : [1, 2, 5];
  const out: number[] = [];
  for (let d = Math.floor(Math.log10(lo)); d <= Math.ceil(Math.log10(hi)); d += 1) {
    for (const s of steps) {
      const v = tidy(s * 10 ** d);
      if (v >= lo && v <= hi && !out.includes(v)) out.push(v);
    }
  }
  return out.length >= 2 ? out : [lo, hi];
}

// one axis over the values that will actually be drawn on it. from and to are
// pixels, and a y axis is handed them the other way round so it grows upward
export function buildAxis(values: number[], from: number, to: number): Axis {
  const log = wantsLog(values);
  const t = (v: number) => (log ? Math.log10(v) : v);
  let lo: number;
  let hi: number;
  let marks: number[];

  if (values.length === 0) {
    lo = 0;
    hi = 1;
    marks = [];
  } else if (log) {
    const min = Math.log10(Math.min(...values));
    const max = Math.log10(Math.max(...values));
    // the domain is the values with a margin, not the decades around them.
    // rounding population out to whole powers of ten left a third of the axis
    // empty, which is the waste a log scale is here to undo. the margin is a
    // share of the span, so it is the same few pixels whatever the metric is
    const pad = (max - min || 1) * PAD_LOG;
    lo = tidy(10 ** (min - pad));
    hi = tidy(10 ** (max + pad));
    marks = logTicks(lo, hi);
  } else {
    // niceTicks pads outward to round numbers, and answers a constant metric
    // with a three tick window around it rather than a zero width domain
    marks = niceTicks(Math.min(...values), Math.max(...values));
    lo = marks[0];
    hi = marks[marks.length - 1];
  }

  const loT = t(lo);
  const hiT = t(hi);
  const place = (v: number) => r1(hiT === loT ? (from + to) / 2 : from + ((v - loT) * (to - from)) / (hiT - loT));
  return {
    scale: log ? "log" : "linear",
    lo,
    hi,
    ticks: marks.map((value) => ({ value, pos: place(t(value)) })),
    at: (v) => place(t(v)),
    place,
  };
}

export function pearson(pairs: [number, number][]): { r: number; slope: number; intercept: number } | null {
  const n = pairs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (const [x, y] of pairs) {
    mx += x / n;
    my += y / n;
  }
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of pairs) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  if (sxx <= 0 || syy <= 0) return null;
  const slope = sxy / sxx;
  return { r: sxy / Math.sqrt(sxx * syy), slope, intercept: my - slope * mx };
}

// ties share the average of the ranks they cover, which is what keeps a metric
// with a floor of zeros from inventing an order it does not have
export function ranks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j += 1;
    const share = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[order[k].i] = share;
    i = j + 1;
  }
  return out;
}

export function spearman(pairs: [number, number][]): number | null {
  if (pairs.length < 2) return null;
  const rx = ranks(pairs.map((p) => p[0]));
  const ry = ranks(pairs.map((p) => p[1]));
  return pearson(rx.map((v, i) => [v, ry[i]] as [number, number]))?.r ?? null;
}

// the fitted line trimmed to the box. the ends already sit at the left and
// right walls, so only the floor and the ceiling can cut it
function clipLine(x1: number, y1: number, x2: number, y2: number, top: number, bottom: number): string {
  const inside = (y: number) => y >= top && y <= bottom;
  if (inside(y1) && inside(y2)) return `M ${r1(x1)} ${r1(y1)} L ${r1(x2)} ${r1(y2)}`;
  if (y1 === y2) return "";
  const cut = (edge: number) => {
    const s = (edge - y1) / (y2 - y1);
    return s >= 0 && s <= 1 ? { x: x1 + s * (x2 - x1), y: edge } : null;
  };
  const ends = [
    inside(y1) ? { x: x1, y: y1 } : null,
    inside(y2) ? { x: x2, y: y2 } : null,
    cut(top),
    cut(bottom),
  ].filter((p): p is { x: number; y: number } => p !== null);
  if (ends.length < 2) return "";
  ends.sort((a, b) => a.x - b.x);
  const a = ends[0];
  const b = ends[ends.length - 1];
  return a.x === b.x && a.y === b.y ? "" : `M ${r1(a.x)} ${r1(a.y)} L ${r1(b.x)} ${r1(b.y)}`;
}

// the axis with its ticks printed the way the metric prints a value
function labelled(axis: Axis, metric: Metric): Axis {
  const signed = metric.kind === "diverging";
  return { ...axis, ticks: axis.ticks.map((t) => ({ ...t, label: formatTick(t.value, metric.format, signed) })) };
}

// every metro that carries both numbers, placed. a value a division took from
// its parent metro is drawn, because it is a real number and hiding it would
// be its own lie, but it is left out of the fit: one parent's listing count
// standing in for three divisions would be that parent counted three times
export function buildExplore(metros: Metro[], x: Metric, y: Metric, size: PlotSize): ExploreModel {
  const top = PAD.top;
  const bottom = size.height - PAD.bottom;

  let missingX = 0;
  let missingY = 0;
  let missing = 0;
  let withheldX = 0;
  let withheldY = 0;
  let whyX: Withheld | null = null;
  let whyY: Withheld | null = null;
  const rows: { metro: Metro; x: number; y: number; inherited: boolean }[] = [];
  for (const metro of metros) {
    const vx = x.accessor(metro);
    const vy = y.accessor(metro);
    if (vx === null) {
      missingX += 1;
      const why = withheldWhy(metro, x);
      if (why) {
        withheldX += 1;
        whyX = why;
      }
    }
    if (vy === null) {
      missingY += 1;
      const why = withheldWhy(metro, y);
      if (why) {
        withheldY += 1;
        whyY = why;
      }
    }
    if (vx === null || vy === null) {
      missing += 1;
      continue;
    }
    rows.push({ metro, x: vx, y: vy, inherited: isInherited(metro, x) || isInherited(metro, y) });
  }

  // the y labels set the left margin and the last x label the right one, so
  // no label is cut off at the edge of the plot
  const yAxis = labelled(buildAxis(rows.map((r) => r.y), bottom, top), y);
  const left = Math.max(PAD.left, ...yAxis.ticks.map((t) => labelWidth(t.label ?? "") + 10));
  const xValues = rows.map((r) => r.x);
  const lastX = labelled(buildAxis(xValues, left, size.width - PAD.right), x).ticks.at(-1)?.label ?? "";
  const right = size.width - Math.max(PAD.right, Math.ceil(labelWidth(lastX) / 2) + 4);
  const xAxis = labelled(buildAxis(xValues, left, right), x);
  const widest = Math.max(0, ...xAxis.ticks.map((t) => labelWidth(t.label ?? "")));
  const gap = xAxis.ticks.length > 1 ? (right - left) / (xAxis.ticks.length - 1) : Infinity;
  const xEvery = widest + 10 > gap ? Math.ceil((widest + 10) / gap) : 1;

  // left to right, which is the order the arrow keys walk the cloud in
  const points: ExplorePoint[] = rows
    .map((r) => ({
      cbsa: r.metro.cbsa,
      name: r.metro.name,
      short: shortLabel(r.metro.name),
      x: r.x,
      y: r.y,
      cx: xAxis.at(r.x),
      cy: yAxis.at(r.y),
      inherited: r.inherited,
    }))
    .sort((a, b) => a.cx - b.cx || a.name.localeCompare(b.name));

  const own = points.filter((p) => !p.inherited);
  const t = (axis: Axis, v: number) => (axis.scale === "log" ? Math.log10(v) : v);
  const pairs = own.map((p) => [t(xAxis, p.x), t(yAxis, p.y)] as [number, number]);
  const line = pairs.length >= MIN_FIT ? pearson(pairs) : null;

  let fitWhy: FitWhy = "ok";
  if (points.length === 0) fitWhy = "empty";
  else if (pairs.length < MIN_FIT) fitWhy = "few";
  else if (line === null) fitWhy = "flat";

  const fit: ExploreFit | null = line === null ? null : {
    slope: line.slope,
    intercept: line.intercept,
    r: line.r,
    r2: line.r * line.r,
    rho: spearman(pairs),
    n: pairs.length,
    d: clipLine(
      left,
      yAxis.place(line.slope * t(xAxis, xAxis.lo) + line.intercept),
      right,
      yAxis.place(line.slope * t(xAxis, xAxis.hi) + line.intercept),
      top,
      bottom,
    ),
  };

  return {
    width: size.width,
    height: size.height,
    left,
    right,
    top,
    bottom,
    radius: size.radius,
    points,
    x: xAxis,
    y: yAxis,
    xEvery,
    fit,
    fitWhy,
    counts: {
      total: metros.length,
      plotted: points.length,
      inherited: points.length - own.length,
      fitted: fit?.n ?? 0,
      missingX,
      missingY,
      missing,
      withheldX,
      withheldY,
      whyX,
      whyY,
    },
  };
}

// the dot nearest a pointer, if it is near enough to have been aimed at
export function nearestPoint(model: ExploreModel, px: number, py: number, reach = REACH): ExplorePoint | null {
  let best: ExplorePoint | null = null;
  let bestDistance = reach * reach;
  for (const point of model.points) {
    const d = (point.cx - px) ** 2 + (point.cy - py) ** 2;
    if (d <= bestDistance) {
      best = point;
      bestDistance = d;
    }
  }
  return best;
}

export interface ExploreEnds {
  xHigh: ExplorePoint[];
  xLow: ExplorePoint[];
  yHigh: ExplorePoint[];
  yLow: ExplorePoint[];
}

// the four corners of the cloud, named. a value taken from a parent metro is
// left out for the same reason the ranking leaves it out: it would put one
// measurement in the table under three different metro names
export function exploreEnds(model: ExploreModel, n = 3): ExploreEnds {
  const own = model.points.filter((p) => !p.inherited);
  const by = (key: "x" | "y", dir: 1 | -1) =>
    [...own].sort((a, b) => dir * (b[key] - a[key]) || a.name.localeCompare(b.name)).slice(0, n);
  return { xHigh: by("x", 1), xLow: by("x", -1), yHigh: by("y", 1), yLow: by("y", -1) };
}

// the metros the line misses by the most, which is the part of a scatter that
// is worth naming out loud
export function exploreOutliers(model: ExploreModel, n = 2): ExplorePoint[] {
  const fit = model.fit;
  if (!fit) return [];
  const t = (axis: Axis, v: number) => (axis.scale === "log" ? Math.log10(v) : v);
  return model.points
    .filter((p) => !p.inherited)
    .map((p) => ({ p, off: Math.abs(t(model.y, p.y) - (fit.slope * t(model.x, p.x) + fit.intercept)) }))
    .sort((a, b) => b.off - a.off)
    .slice(0, n)
    .map((row) => row.p);
}

// how much of a relationship there is, in words, with nothing in them that
// says one metric moved the other
export function fitStrength(r: number): string {
  const size = Math.abs(r);
  if (size < 0.2) return "next to no straight line relationship";
  if (size < 0.5) return "a weak straight line relationship";
  if (size < 0.8) return "a moderate straight line relationship";
  return "a strong straight line relationship";
}

const be = (n: number) => (n === 1 ? "is" : "are");
const has = (n: number) => (n === 1 ? "has" : "have");

// "92 have no Median income growth, 2014 to 2024, 78 of them withheld because
// the county lines moved". a withheld number and one nobody measured are
// different claims, so the count says how many of the blanks are which
function missingPart(count: number, label: string, withheld = 0, why: Withheld | null = null): string {
  const part = `${count} ${has(count)} no ${label}`;
  if (withheld <= 0 || why === null) return part;
  const which = withheld === count ? (count === 1 ? "it withheld" : "all of them withheld") : `${withheld} of them withheld`;
  return `${part}, ${which} because ${withheldBecause(why)}`;
}

// a scatter that quietly drops 45 metros is a lie, so the count is written out
// wherever either metric is short of the full build
export function plottedSentence(counts: ExploreCounts, xLabel: string, yLabel: string): string {
  if (counts.total === 0) return "There are no metros in this build.";
  if (counts.plotted === counts.total) return `All ${counts.total} metros carry both numbers and all ${counts.total} are drawn.`;
  const why: string[] = [];
  if (counts.missingX > 0) why.push(missingPart(counts.missingX, xLabel, counts.withheldX, counts.whyX));
  if (counts.missingY > 0) why.push(missingPart(counts.missingY, yLabel, counts.withheldY, counts.whyY));
  const tail = why.length ? `: ${why.join("; ")}` : "";
  return `${counts.plotted} of ${counts.total} metros are drawn. ${counts.missing} ${be(counts.missing)} missing at least one of the two${tail}.`;
}

export function inheritedSentence(counts: ExploreCounts): string {
  if (counts.inherited === 0) return "";
  return `${counts.inherited} of the dots ${be(counts.inherited)} hollow: ${counts.inherited === 1 ? "a metropolitan division whose" : "metropolitan divisions whose"} number for one of these metrics is the parent metro's. They are drawn but left out of the line, so one parent is not counted more than once.`;
}

export function fitSentence(model: ExploreModel, yLabel: string): string {
  const fit = model.fit;
  if (!fit) {
    switch (model.fitWhy) {
      case "empty": return "There is nothing to fit.";
      case "few": return `Fewer than ${MIN_FIT} metros carry both numbers and their own measurement of each, so no line is drawn.`;
      default: return "One of the two metrics is the same for every metro drawn, so there is no line to fit.";
    }
  }
  const rho = fit.rho === null ? "" : ` The rank correlation is ${fit.rho.toFixed(2)}.`;
  // a line solved in one space and drawn in another is not the line on screen,
  // so it is solved on the axes as they are drawn and the reader is told when
  // one of them is in logs
  const logged = model.x.scale === "log" || model.y.scale === "log";
  const where = logged ? " An axis in powers of ten is fitted in logs." : "";
  return `A least squares line through the ${fit.n} metros that measure both: r is ${fit.r.toFixed(2)}, so it accounts for ${Math.round(fit.r2 * 100)} percent of the spread in ${yLabel}, ${fitStrength(fit.r)}.${rho}${where}`;
}

// what a reader who cannot see the cloud is handed in its place
export function exploreTitle(model: ExploreModel, xLabel: string, yLabel: string): string {
  if (model.points.length === 0) return `${yLabel} against ${xLabel}. No metro in this build carries both numbers, so there is nothing to draw.`;
  const scales = [
    model.x.scale === "log" ? "the horizontal axis is logarithmic" : "",
    model.y.scale === "log" ? "the vertical axis is logarithmic" : "",
  ].filter(Boolean).join(" and ");
  const fit = model.fit ? ` The fitted line has an r of ${model.fit.r.toFixed(2)}.` : "";
  return `${yLabel} against ${xLabel}, one dot per metro. ${model.counts.plotted} of ${model.counts.total} metros are drawn${scales ? `, ${scales}` : ""}.${fit}`;
}

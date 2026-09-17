import { describe, expect, it } from "vitest";
import {
  MIN_FIT, buildAxis, buildExplore, exploreEnds, exploreOutliers, exploreTitle, fitSentence, fitStrength,
  inheritedSentence, logTicks, nearestPoint, pearson, plotSize, plottedSentence, ranks, spearman, wantsLog,
} from "./explore";
import { defById, resolveMetric } from "./metrics";
import type { Metro, YearValues } from "../types";

const blank = (): YearValues => ({
  hpi: null, income: null, pop: null, age: null, degree_share: null,
  own_rate: null, home_value: null, zhvi: null, zori: null, unemp: null,
});

// two real definitions, both read at latest, so the tests run through the same
// accessor and the same isInherited the view does
const X = resolveMetric(defById("permits_units")!.def, "latest");
const Y = resolveMetric(defById("pop_estimate")!.def, "latest");

const metro = (cbsa: string, permits: number | null, pop: number | null, inherited: string[] = []): Metro => ({
  cbsa,
  name: `Metro ${cbsa}, ST`,
  lat: 0,
  lon: 0,
  years: { "2014": blank(), "2019": blank(), "2024": blank() },
  latest: {
    zhvi: null, zhvi_date: null, zori: null, zori_date: null, unemp: null, unemp_date: null,
    permits_units: permits, pop_estimate: pop,
  },
  growth: { hpi_14_19: null, hpi_19_24: null, income_14_24: null, pop_14_24: null, home_value_14_24: null },
  ptir: { "2014": null, "2019": null, "2024": null },
  parent_metrics: inherited,
});

const size = plotSize("wide");
const build = (metros: Metro[]) => buildExplore(metros, X, Y, size);

// a straight line with one point knocked off it, so the fit is strong but not
// perfect and there is an outlier to find
const line = (n: number) => Array.from({ length: n }, (_, i) => metro(String(10000 + i), i + 1, (i + 1) * 10));

describe("choosing between a plain axis and a logarithmic one", () => {
  it("leaves a metric that spans less than an order of magnitude alone", () => {
    expect(wantsLog([100, 120, 140, 160, 180, 200, 220, 240])).toBe(false);
  });

  it("takes the log of a metric whose values span six orders of magnitude", () => {
    expect(wantsLog([1, 10, 100, 1000, 10000, 100000, 1000000, 5])).toBe(true);
  });

  it("refuses a log axis when any value is zero or negative, whatever the spread", () => {
    expect(wantsLog([0, 10, 100, 1000, 10000, 100000, 1000000, 5])).toBe(false);
    expect(wantsLog([-1, 10, 100, 1000, 10000, 100000, 1000000, 5])).toBe(false);
  });

  it("refuses a log axis when there are too few values to judge the spread", () => {
    expect(wantsLog([1, 1000000])).toBe(false);
  });
});

describe("the axis a set of values gets", () => {
  it("places the low end at the near edge and the high end at the far edge", () => {
    const axis = buildAxis([0, 10], 0, 100);
    expect(axis.scale).toBe("linear");
    expect(axis.at(axis.lo)).toBe(0);
    expect(axis.at(axis.hi)).toBe(100);
  });

  it("runs backwards when it is handed its pixels backwards, which is how a vertical axis grows upward", () => {
    const axis = buildAxis([0, 10], 400, 0);
    expect(axis.at(axis.lo)).toBe(400);
    expect(axis.at(axis.hi)).toBe(0);
  });

  it("gives a metric with no variance at all a window around its one value rather than a zero width domain", () => {
    const axis = buildAxis([7, 7, 7, 7], 0, 100);
    expect(axis.lo).toBeLessThan(7);
    expect(axis.hi).toBeGreaterThan(7);
    expect(axis.at(7)).toBe(50);
  });

  // rounding out to whole decades left a third of the axis empty, which is the
  // waste a log scale is there to undo in the first place
  it("holds a logarithmic domain close to the values in it, with a margin and no more", () => {
    const axis = buildAxis([3, 40, 500, 6000, 70000, 800000, 9000000, 12], 0, 100);
    expect(axis.scale).toBe("log");
    expect(axis.lo).toBeLessThan(3);
    expect(axis.hi).toBeGreaterThan(9000000);
    // the lowest and the highest value sit within a few percent of the walls
    expect(axis.at(3)).toBeGreaterThan(1);
    expect(axis.at(3)).toBeLessThan(5);
    expect(axis.at(9000000)).toBeGreaterThan(95);
    expect(axis.at(9000000)).toBeLessThan(99);
    expect(axis.ticks.every((t) => t.value >= axis.lo && t.value <= axis.hi)).toBe(true);
  });

  it("has no ticks and a usable domain when it is given nothing to draw", () => {
    const axis = buildAxis([], 0, 100);
    expect(axis.ticks).toEqual([]);
    expect(Number.isFinite(axis.at(1))).toBe(true);
  });

  it("subdivides a short logarithmic range and leaves a long one at whole decades", () => {
    expect(logTicks(100, 1000)).toEqual([100, 200, 500, 1000]);
    expect(logTicks(1, 100000)).toEqual([1, 10, 100, 1000, 10000, 100000]);
  });
});

describe("the correlation the fit reports", () => {
  it("is one for a rising straight line and minus one for a falling one", () => {
    expect(pearson([[1, 2], [2, 4], [3, 6]])!.r).toBeCloseTo(1, 10);
    expect(pearson([[1, 6], [2, 4], [3, 2]])!.r).toBeCloseTo(-1, 10);
  });

  it("is refused when either side never varies, which is what breaks a naive fit", () => {
    expect(pearson([[1, 5], [2, 5], [3, 5]])).toBeNull();
    expect(pearson([[5, 1], [5, 2], [5, 3]])).toBeNull();
  });

  it("is refused for fewer than two points", () => {
    expect(pearson([[1, 1]])).toBeNull();
    expect(spearman([])).toBeNull();
  });

  it("shares a rank between tied values rather than inventing an order", () => {
    expect(ranks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });

  it("reads a curve that only ever rises as a perfect rank correlation, where the straight line fit does not", () => {
    const curved: [number, number][] = [[1, 1], [2, 10], [3, 100], [4, 1000], [5, 10000]];
    expect(spearman(curved)).toBeCloseTo(1, 10);
    expect(pearson(curved)!.r).toBeLessThan(0.9);
  });

  it("describes a relationship in words without ever saying one metric moved the other", () => {
    expect(fitStrength(0.05)).toContain("next to no");
    expect(fitStrength(-0.35)).toContain("weak");
    expect(fitStrength(0.62)).toContain("moderate");
    expect(fitStrength(-0.94)).toContain("strong");
    for (const r of [0.05, -0.35, 0.62, -0.94]) expect(fitStrength(r)).not.toContain("cause");
  });
});

describe("the plot built from a set of metros", () => {
  it("draws nothing and fits nothing when both metrics are null for every metro", () => {
    const model = build([metro("10000", null, null), metro("10001", null, null)]);
    expect(model.points).toEqual([]);
    expect(model.fit).toBeNull();
    expect(model.fitWhy).toBe("empty");
    expect(model.counts).toMatchObject({ total: 2, plotted: 0, missing: 2, missingX: 2, missingY: 2 });
  });

  it("draws the one metro it has and refuses to fit a line to it", () => {
    const model = build([metro("10000", 5, 50)]);
    expect(model.points).toHaveLength(1);
    expect(model.fit).toBeNull();
    expect(model.fitWhy).toBe("few");
    expect(model.points[0].cx).toBeGreaterThanOrEqual(model.left);
    expect(model.points[0].cy).toBeLessThanOrEqual(model.bottom);
  });

  it("refuses to fit a line to two metros, which any two points lie on exactly", () => {
    const model = build([metro("10000", 5, 50), metro("10001", 9, 90)]);
    expect(model.points).toHaveLength(2);
    expect(model.fit).toBeNull();
    expect(model.fitWhy).toBe("few");
  });

  it("fits a line once there are enough metros to be worth fitting", () => {
    const model = build(line(MIN_FIT));
    expect(model.fit).not.toBeNull();
    expect(model.fit!.r).toBeCloseTo(1, 10);
    expect(model.fit!.n).toBe(MIN_FIT);
    expect(model.fit!.d).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
  });

  it("draws every metro but fits no line when one metric is the same for all of them", () => {
    const flat = Array.from({ length: 8 }, (_, i) => metro(String(10000 + i), i + 1, 500));
    const model = build(flat);
    expect(model.points).toHaveLength(8);
    expect(model.fit).toBeNull();
    expect(model.fitWhy).toBe("flat");
    expect(fitSentence(model, "population")).toContain("same for every metro");
  });

  it("keeps a metro that spans six orders of magnitude inside the box rather than in one corner", () => {
    const wide = [1, 10, 100, 1000, 10000, 100000, 1000000, 5].map((v, i) => metro(String(10000 + i), v, v * 10));
    const model = build(wide);
    expect(model.x.scale).toBe("log");
    for (const point of model.points) {
      expect(point.cx).toBeGreaterThanOrEqual(model.left);
      expect(point.cx).toBeLessThanOrEqual(model.right);
    }
    // the contrast a log axis buys: on a plain one every value up to a hundred
    // lands in the leftmost percent of the box, on this one they take a quarter
    const span = model.right - model.left;
    const small = model.points.filter((p) => p.x <= 100);
    const plain = model.left + ((100 - 1) * span) / (1000000 - 1);
    expect(plain).toBeLessThan(model.left + span / 50);
    expect(Math.max(...small.map((p) => p.cx))).toBeGreaterThan(model.left + span / 4);
  });

  it("counts the metros it left out and says which metric was missing for them", () => {
    const model = build([
      metro("10000", 5, 50), metro("10001", 9, 90), metro("10002", null, 30), metro("10003", 4, null),
      metro("10004", null, null),
    ]);
    expect(model.counts).toMatchObject({ total: 5, plotted: 2, missing: 3, missingX: 2, missingY: 2 });
    const sentence = plottedSentence(model.counts, "permits", "population");
    expect(sentence).toContain("2 of 5 metros are drawn");
    expect(sentence).toContain("2 have no permits");
    expect(sentence).toContain("2 have no population");
  });

  it("says so plainly when every metro carries both numbers", () => {
    const model = build(line(6));
    expect(plottedSentence(model.counts, "permits", "population")).toContain("All 6 metros");
  });

  it("draws a value a division took from its parent metro but keeps it out of the line", () => {
    const metros = [...line(6), metro("19999", 1000, 40, ["permits_units"])];
    const model = build(metros);
    expect(model.counts.plotted).toBe(7);
    expect(model.counts.inherited).toBe(1);
    expect(model.fit!.n).toBe(6);
    expect(model.points.find((p) => p.cbsa === "19999")!.inherited).toBe(true);
    expect(inheritedSentence(model.counts)).toContain("hollow");
  });

  it("keeps an inherited value out of the ends table for the same reason it keeps it out of the line", () => {
    const metros = [...line(6), metro("19999", 99999, 99999, ["permits_units", "pop_estimate"])];
    const ends = exploreEnds(build(metros));
    expect(ends.xHigh.map((p) => p.cbsa)).not.toContain("19999");
    expect(ends.yHigh.map((p) => p.cbsa)).not.toContain("19999");
  });

  it("names the metros the line misses by the most", () => {
    const metros = [...line(8), metro("19999", 4, 900)];
    const model = build(metros);
    expect(exploreOutliers(model, 1).map((p) => p.cbsa)).toEqual(["19999"]);
  });

  it("has no outliers to name when there is no line", () => {
    expect(exploreOutliers(build([metro("10000", 5, 50)]))).toEqual([]);
  });

  it("orders its dots from left to right, so the arrow keys walk the cloud in one direction", () => {
    const model = build([metro("10000", 9, 90), metro("10001", 1, 10), metro("10002", 5, 50)]);
    expect(model.points.map((p) => p.cbsa)).toEqual(["10001", "10002", "10000"]);
  });

  it("hands back the dot the pointer is nearest, and nothing at all when the pointer is nowhere near one", () => {
    const model = build(line(6));
    const target = model.points[2];
    expect(nearestPoint(model, target.cx + 2, target.cy + 2)!.cbsa).toBe(target.cbsa);
    expect(nearestPoint(model, target.cx, target.cy, 0.5)).not.toBeNull();
    expect(nearestPoint(model, -500, -500)).toBeNull();
  });

  it("tells a reader who cannot see the cloud how many metros are in it and how well the line does", () => {
    const model = build(line(8));
    const title = exploreTitle(model, "permits", "population");
    expect(title).toContain("8 of 8 metros are drawn");
    expect(title).toContain("r of 1.00");
  });

  it("says there is nothing to draw rather than describing an empty plot", () => {
    const model = build([metro("10000", null, null)]);
    expect(exploreTitle(model, "permits", "population")).toContain("nothing to draw");
    expect(fitSentence(model, "population")).toContain("nothing to fit");
  });

  it("reports the fit with its metro count, its r and the share of the spread it accounts for", () => {
    const model = build(line(8));
    const sentence = fitSentence(model, "population");
    expect(sentence).toContain("8 metros");
    expect(sentence).toContain("r is 1.00");
    expect(sentence).toContain("100 percent");
    expect(sentence).not.toContain("cause");
  });
});

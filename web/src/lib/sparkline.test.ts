import { describe, expect, it } from "vitest";
import { buildSparkline } from "./sparkline";

describe("buildSparkline", () => {
  it("centers a single point and draws no line", () => {
    const spark = buildSparkline([5], 100, 40);
    expect(spark.d).toBe("");
    expect(spark.points).toHaveLength(1);
    expect(spark.points[0].x).toBe(50);
    expect(spark.points[0].y).toBe(20);
  });

  it("joins two points with one segment", () => {
    const spark = buildSparkline([1, 2], 100, 40);
    expect(spark.d).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
    expect(spark.points[1].y).toBeLessThan(spark.points[0].y);
  });

  it("joins three points with two segments", () => {
    const spark = buildSparkline([1, 3, 2]);
    expect(spark.d.split(" L ")).toHaveLength(3);
  });

  it("leaves a gap around a null in the middle", () => {
    const spark = buildSparkline([1, null, 3]);
    expect(spark.d).toBe("");
    expect(spark.points.map((p) => p.index)).toEqual([0, 2]);
  });

  it("keeps the segment that precedes a trailing null", () => {
    const spark = buildSparkline([1, 2, null]);
    expect(spark.d).toMatch(/^M .* L /);
    expect(spark.points).toHaveLength(2);
  });

  it("returns nothing for all nulls", () => {
    expect(buildSparkline([null, null])).toMatchObject({ d: "", points: [] });
  });

  it("does not produce nan on constant values", () => {
    const spark = buildSparkline([4, 4, 4], 100, 40);
    spark.points.forEach((p) => {
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBe(20);
    });
  });

  // 37: a null keeps its place on the x axis, which is what makes a gap a gap
  // rather than a line drawn at the wrong width
  it("places x by the value's place in the series, nulls included", () => {
    const spark = buildSparkline([1, null, null, 4], 100, 48, 10);
    expect(spark.points.map((p) => p.index)).toEqual([0, 3]);
    expect(spark.points.map((p) => p.x)).toEqual([10, 90]);
    // the same two values with the nulls taken out sit at the same two ends,
    // so the gap has to be read off the index, not off the spacing
    const dense = buildSparkline([1, 4], 100, 48, 10);
    expect(dense.points.map((p) => p.x)).toEqual([10, 90]);
    expect(dense.d).not.toBe("");
    expect(spark.d).toBe("");
  });

  // 50: y is tied to the magnitude across the whole series, not just ordered
  it("puts y in proportion to the value between the low and the high", () => {
    const spark = buildSparkline([0, 25, 50, 75, 100], 100, 48, 4);
    const ys = spark.points.map((p) => p.y);
    // the box is 48 tall with 4 of pad, so 40 of drawable height
    expect(ys).toEqual([44, 34, 24, 14, 4]);
    // and the steps are equal, which ordering alone would not give
    const steps = ys.slice(1).map((y, i) => ys[i] - y);
    for (const step of steps) expect(step).toBeCloseTo(steps[0]);
  });

  // 82: a nan or an infinity in the values is not a point. without the filter
  // it reaches the path and the whole line disappears from the svg
  it("keeps a nan or an infinity out of the points and out of the path", () => {
    const spark = buildSparkline([1, Number.NaN, 3, Number.POSITIVE_INFINITY, 5], 100, 48, 4);
    expect(spark.points.map((p) => p.value)).toEqual([1, 3, 5]);
    expect(spark.d).not.toContain("NaN");
    expect(spark.d).not.toContain("Infinity");
    expect(buildSparkline([Number.NaN, Number.NaN]).points).toEqual([]);
  });

  // 74: a pad wider than half the box left no room to draw in, and the scale
  // inverted: the drawable height went negative and low values were drawn
  // above high ones. no caller is close, the inline spark is 14px with pad 3
  it("survives a pad wider than the box without turning the axis upside down", () => {
    for (const [w, h, pad] of [[14, 14, 3], [10, 4, 3], [6, 6, 6], [8, 8, 40]] as const) {
      const spark = buildSparkline([1, 2, 3], w, h, pad);
      const ys = spark.points.map((p) => p.y);
      const xs = spark.points.map((p) => p.x);
      expect(ys[0], `${w}x${h} pad ${pad}`).toBeGreaterThanOrEqual(ys[2]);
      expect(xs[0], `${w}x${h} pad ${pad}`).toBeLessThanOrEqual(xs[2]);
      for (const p of spark.points) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y), `${w}x${h} pad ${pad}`).toBe(true);
        expect(p.y >= 0 && p.y <= h, `y ${p.y} inside ${h}`).toBe(true);
        expect(p.x >= 0 && p.x <= w, `x ${p.x} inside ${w}`).toBe(true);
      }
    }
  });
});

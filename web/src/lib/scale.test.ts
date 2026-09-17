import { describe, expect, it } from "vitest";
import { buildScale } from "./scale";
import { DIVERGING, NULL_GRAY, SEQUENTIAL } from "./palette";

describe("sequential scale", () => {
  it("is empty for all nulls and colors everything gray", () => {
    const scale = buildScale([null, null], "sequential");
    expect(scale.domain).toBeNull();
    expect(scale.bins).toEqual([]);
    expect(scale.color(null)).toBe(NULL_GRAY);
    expect(scale.color(5)).toBe(NULL_GRAY);
  });

  it("does not divide by zero on a single distinct value", () => {
    const scale = buildScale([7, 7, 7], "sequential");
    expect(scale.domain).toEqual([7, 7]);
    expect(scale.bins).toHaveLength(1);
    expect(SEQUENTIAL).toContain(scale.color(7));
    expect(scale.color(null)).toBe(NULL_GRAY);
  });

  it("maps low to light and high to dark with five bins", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const scale = buildScale(values, "sequential");
    expect(scale.bins).toHaveLength(5);
    expect(scale.color(1)).toBe(SEQUENTIAL[0]);
    expect(scale.color(100)).toBe(SEQUENTIAL[4]);
    expect(scale.color(50)).toBe(SEQUENTIAL[2]);
  });

  it("clamps values outside the domain", () => {
    const scale = buildScale([10, 20, 30, 40, 50, 60], "sequential");
    expect(scale.color(-100)).toBe(SEQUENTIAL[0]);
    expect(scale.color(1000)).toBe(SEQUENTIAL[4]);
  });

  it("falls back to equal width when ties collapse the quantiles", () => {
    const scale = buildScale([1, 1, 1, 1, 1, 1, 1, 1, 1, 10], "sequential");
    expect(scale.bins).toHaveLength(5);
    const widths = scale.bins.map((b) => b.to - b.from);
    widths.forEach((w) => expect(w).toBeCloseTo(widths[0]));
    expect(scale.bins.every((b) => Number.isFinite(b.from) && Number.isFinite(b.to))).toBe(true);
  });

  it("ignores nulls when building the domain", () => {
    const scale = buildScale([null, 2, null, 4, 6, 8, 10], "sequential");
    expect(scale.domain).toEqual([2, 10]);
  });
});

describe("diverging scale", () => {
  it("centers on zero with a symmetric domain", () => {
    const scale = buildScale([-0.1, 0.05, 0.4], "diverging");
    // the domain ends at the magnitude quantile rather than at the largest
    // value, so it is symmetric around zero without being the raw extreme
    expect(scale.domain![0]).toBe(-scale.domain![1]);
    expect(scale.domain![1]).toBeGreaterThan(0.1);
    expect(scale.domain![1]).toBeLessThanOrEqual(0.4);
    const middle = scale.bins[2];
    expect(middle.from).toBeCloseTo(-middle.to);
    expect(scale.color(0)).toBe(DIVERGING[2]);
  });

  it("puts negatives on the blue arm and positives on the red arm", () => {
    const scale = buildScale([-1, 1], "diverging");
    expect(scale.color(-1)).toBe(DIVERGING[0]);
    expect(scale.color(1)).toBe(DIVERGING[4]);
    expect(scale.color(-0.5)).toBe(DIVERGING[1]);
    expect(scale.color(0.5)).toBe(DIVERGING[3]);
  });

  it("handles all zeros without a zero width domain", () => {
    const scale = buildScale([0, 0], "diverging");
    expect(scale.kind).toBe("diverging");
    expect(scale.domain).toEqual([-1, 1]);
    expect(scale.color(0)).toBe(DIVERGING[2]);
  });
});

// asking for a diverging ramp is asking for two directions. a run that has
// only one of them gets the sequential ramp instead, because the empty half of
// a diverging legend is a promise the data never makes
// one outlier used to set the width of all five classes, because the domain
// ran to the largest magnitude in the data. net domestic migration put 404 of
// 410 metros in the neutral middle, which is not a map. the domain ends at the
// 95th percentile of magnitude now and the end classes take everything past it,
// which is what the animated annual run has always done
describe("a diverging run with a long tail", () => {
  // ninety nine ordinary metros and one that dwarfs them
  const heavy = [...Array.from({ length: 99 }, (_, i) => (i % 2 ? 1 : -1) * (i + 1)), 100000];

  it("ends the domain at the magnitude quantile, not at the outlier", () => {
    const scale = buildScale(heavy, "diverging");
    expect(scale.kind).toBe("diverging");
    expect(scale.clipped).toBe(true);
    expect(scale.domain![1]).toBeLessThan(200);
    expect(scale.domain![0]).toBe(-scale.domain![1]);
  });

  it("spreads the ordinary metros across the classes instead of piling them in the middle", () => {
    const counts = (values: number[]) => {
      const scale = buildScale(values, "diverging");
      return scale.bins.map((b) => values.filter((v) => scale.color(v) === b.color).length);
    };
    const spread = counts(heavy);
    expect(spread[2]).toBeLessThan(heavy.length / 2);
    for (const n of spread) expect(n).toBeGreaterThan(0);
  });

  it("gives the outlier the end colour rather than a class of its own", () => {
    const scale = buildScale(heavy, "diverging");
    expect(scale.color(100000)).toBe(DIVERGING[4]);
    expect(scale.color(scale.domain![1])).toBe(DIVERGING[4]);
  });

  // nothing is past the end of a run whose extreme is shared, so the legend
  // does not say "or more" where there is no more
  it("does not clip a run whose extreme is not a lone outlier", () => {
    const flat = [...Array(5).fill(-10), ...Array(5).fill(10)];
    const scale = buildScale(flat, "diverging");
    expect(scale.clipped).toBe(false);
    expect(scale.domain).toEqual([-10, 10]);
  });

  it("still centres on zero, so the middle class is the neutral one", () => {
    const scale = buildScale(heavy, "diverging");
    const middle = scale.bins[2];
    expect(middle.from).toBeCloseTo(-middle.to);
    expect(scale.color(0)).toBe(DIVERGING[2]);
  });
});

describe("a diverging metric whose values never change sign", () => {
  it("reads on the sequential ramp, with every class carrying values", () => {
    const values = Array.from({ length: 100 }, (_, i) => 0.147 + (i * 0.0073));
    const scale = buildScale(values, "diverging");
    expect(scale.kind).toBe("sequential");
    expect(scale.bins).toHaveLength(5);
    expect(scale.domain![0]).toBeCloseTo(0.147);
    for (const bin of scale.bins) {
      expect(values.some((v) => v >= bin.from && v <= bin.to), `${bin.from} to ${bin.to}`).toBe(true);
    }
    expect(scale.color(0.147)).toBe(SEQUENTIAL[0]);
    expect(scale.color(scale.domain![1])).toBe(SEQUENTIAL[4]);
  });

  it("does the same for a run that is negative throughout", () => {
    const scale = buildScale([-0.4, -0.3, -0.2, -0.1], "diverging");
    expect(scale.kind).toBe("sequential");
    expect(scale.domain).toEqual([-0.4, -0.1]);
    // the ramp still runs light to dark with the value, so the deepest loss
    // is the lightest, which is what "low to light" means on a negative run
    expect(scale.color(-0.4)).toBe(SEQUENTIAL[0]);
    expect(scale.color(-0.1)).toBe(SEQUENTIAL[4]);
  });

  it("keeps the symmetric ramp the moment a single value crosses zero", () => {
    expect(buildScale([0.2, 0.3], "diverging").kind).toBe("sequential");
    const crossing = buildScale([-0.01, 0.2, 0.3], "diverging");
    expect(crossing.kind).toBe("diverging");
    expect(crossing.domain![0]).toBe(-crossing.domain![1]);
  });

  // a zero is not a direction, so a run that touches zero from one side only
  // is still one sided
  it("counts a zero as neither direction", () => {
    expect(buildScale([0, 0.2, 0.3], "diverging").kind).toBe("sequential");
    expect(buildScale([0, -0.2, -0.3], "diverging").kind).toBe("sequential");
  });

  // the animated year run hands the scale its own symmetric cap rather than
  // the year's values, which is what keeps one colour scale across fifty years
  it("leaves a run built from an explicit symmetric domain alone", () => {
    expect(buildScale([-0.1, 0.1], "diverging").kind).toBe("diverging");
  });
});
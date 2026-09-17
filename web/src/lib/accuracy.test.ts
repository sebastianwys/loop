import { describe, expect, it } from "vitest";
import {
  barAt, buildHistogram, buildScatter, chartBox, collectMisses, coverage, errorBins, extremes, fitLine,
  histogramTitle, nearestMetro, quantileOf, ranksOf, scatterTitle, stance, stateOf, stateSpread, summarize,
} from "./accuracy";
import type { Latest, Metro, YearValues } from "../types";

const YEAR: YearValues = {
  hpi: null, income: null, pop: null, age: null, degree_share: null,
  own_rate: null, home_value: null, zhvi: null, zori: null, unemp: null,
};

const LATEST: Latest = {
  zhvi: null, zhvi_date: null, zori: null, zori_date: null, unemp: null, unemp_date: null,
};

function metro(cbsa: string, name: string, latest: Partial<Latest> = {}, level?: "msa" | "division"): Metro {
  return {
    cbsa,
    name,
    level,
    lat: 0,
    lon: 0,
    years: { "2014": { ...YEAR }, "2019": { ...YEAR }, "2024": { ...YEAR } },
    latest: { ...LATEST, ...latest },
    growth: { hpi_14_19: null, hpi_19_24: null, income_14_24: null, pop_14_24: null, home_value_14_24: null },
    ptir: { "2014": null, "2019": null, "2024": null },
  };
}

// a scored metro: realized growth, the surprise against it, and fhfa's error
const scored = (cbsa: string, name: string, realized: number, surprise: number, error: number | null = null) =>
  metro(cbsa, name, {
    hpi_yoy_latest: realized,
    hpi_surprise_4q: surprise,
    ...(error === null ? {} : { hpi_index_error: error }),
  });

// five metros whose misses are -2, -1, 0, 1 and 2, so every centre and
// spread figure below can be checked by hand
const EVEN = [
  scored("10180", "Abilene, TX", 1, -2, 0.2),
  scored("19100", "Dallas-Fort Worth-Arlington, TX", 2, -1, 0.4),
  scored("25980", "Hinesville, GA", 3, 0, 0.6),
  scored("31080", "Los Angeles-Long Beach-Anaheim, CA", 4, 1, 0.8),
  scored("41860", "San Francisco-Oakland-Fremont, CA", 5, 2, 1.0),
];

describe("reading the model's scored calls off the metros", () => {
  it("names the metro, its state and both sides of the arithmetic for every scored call", () => {
    const misses = collectMisses([scored("10180", "Abilene, TX", 2, -1.1, 0.3)]);
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ cbsa: "10180", name: "Abilene, TX", state: "TX", surprise: -1.1, error: 0.3 });
    expect(misses[0].realized).toBe(2);
    // the model said 3.1 and the metro managed 2, so the miss is -1.1
    expect(misses[0].expected).toBeCloseTo(3.1, 10);
  });

  it("leaves a metro with no surprise out of the scoring rather than counting it as a miss of zero", () => {
    const metros = [scored("10180", "Abilene, TX", 2, -1.1), metro("19100", "Dallas-Fort Worth-Arlington, TX", { hpi_yoy_latest: 4 })];
    const misses = collectMisses(metros);
    expect(misses.map((m) => m.cbsa)).toEqual(["10180"]);
    expect(summarize(misses)!.mean).toBeCloseTo(-1.1, 10);
    // the unscored metro would have pulled the mean halfway to zero
    expect(summarize(misses)!.n).toBe(1);
  });

  it("returns nothing at all for an empty metro list", () => {
    expect(collectMisses([])).toEqual([]);
    expect(summarize([])).toBeNull();
    expect(stateSpread([])).toBeNull();
    expect(stance([])).toBeNull();
    expect(coverage([], [])).toMatchObject({ metros: 0, scored: 0, unscored: 0 });
  });

  it("leaves out a metro whose latest fields are every one of them null", () => {
    const empty = metro("10180", "Abilene, TX", {
      hpi_surprise_4q: null, hpi_yoy_latest: null, hpi_index_error: null,
      hpi_forecast_4q: null, hpi_forecast_4q_lo: null, hpi_forecast_4q_hi: null,
    });
    expect(collectMisses([empty])).toEqual([]);
    expect(stance([empty])).toBeNull();
    expect(coverage([empty], [])).toMatchObject({ metros: 1, scored: 0, unscored: 1 });
  });

  it("treats a surprise that is not a finite number as no surprise at all", () => {
    const broken = metro("10180", "Abilene, TX", { hpi_surprise_4q: Number.NaN, hpi_yoy_latest: 2 });
    expect(collectMisses([broken])).toEqual([]);
  });

  it("keeps a scored metro that carries no index standard error, with a null rather than a zero", () => {
    const misses = collectMisses([scored("10180", "Abilene, TX", 2, -1.1)]);
    expect(misses[0].error).toBeNull();
    expect(coverage([scored("10180", "Abilene, TX", 2, -1.1)], misses).withError).toBe(0);
  });

  it("keeps a metro whose realized growth is missing, and reports no arithmetic to go with its miss", () => {
    const misses = collectMisses([metro("10180", "Abilene, TX", { hpi_surprise_4q: -1.1 })]);
    expect(misses).toHaveLength(1);
    expect(misses[0].realized).toBeNull();
    expect(misses[0].expected).toBeNull();
  });

  it("counts how many of the scored metros are divisions inside a larger metro", () => {
    const metros = [
      scored("10180", "Abilene, TX", 2, -1),
      metro("11244", "Anaheim-Santa Ana-Irvine, CA", { hpi_surprise_4q: 1, hpi_yoy_latest: 3 }, "division"),
    ];
    expect(coverage(metros, collectMisses(metros))).toMatchObject({ metros: 2, scored: 2, unscored: 0, divisions: 1 });
  });
});

describe("naming the state a metro belongs to", () => {
  it("takes the postal code off the end of the name", () => {
    expect(stateOf("Abilene, TX")).toBe("TX");
    expect(stateOf("Dallas-Fort Worth-Arlington, TX")).toBe("TX");
  });

  it("files a metro that straddles a border under the first state named", () => {
    expect(stateOf("Paducah, KY-IL")).toBe("KY");
    expect(stateOf("Washington-Arlington-Alexandria, DC-VA-MD-WV")).toBe("DC");
  });

  it("gives back an empty string for a name with no state in it", () => {
    expect(stateOf("Nowhere")).toBe("");
    expect(stateOf("")).toBe("");
  });
});

describe("summarizing the distribution of the miss", () => {
  it("reports the centre, the spread and the typical size of a symmetric set of misses", () => {
    const s = summarize(collectMisses(EVEN))!;
    expect(s.n).toBe(5);
    expect(s.mean).toBeCloseTo(0, 10);
    expect(s.median).toBeCloseTo(0, 10);
    expect(s.sd).toBeCloseTo(Math.sqrt(2.5), 10);
    expect(s.mae).toBeCloseTo(1.2, 10);
    expect(s.rmse).toBeCloseTo(Math.sqrt(2), 10);
    expect([s.q1, s.q3]).toEqual([-1, 1]);
    expect([s.min, s.max]).toEqual([-2, 2]);
    expect(s.skew).toBeCloseTo(0, 10);
  });

  it("says what share of metros came in under the model, which is the bias in one number", () => {
    const biased = summarize(collectMisses([
      scored("10180", "Abilene, TX", 1, -3),
      scored("19100", "Dallas-Fort Worth-Arlington, TX", 1, -2),
      scored("25980", "Hinesville, GA", 1, -2),
      scored("31080", "Los Angeles-Long Beach-Anaheim, CA", 1, -1),
      scored("41860", "San Francisco-Oakland-Fremont, CA", 1, 4),
    ]))!;
    expect(biased.high).toBeCloseTo(0.8, 10);
    expect(biased.mean).toBeCloseTo(-0.8, 10);
    expect(biased.median).toBeCloseTo(-2, 10);
  });

  it("gives a single scored metro a centre and no spread, rather than a not a number", () => {
    const s = summarize(collectMisses([scored("10180", "Abilene, TX", 2, -1.5)]))!;
    expect(s.n).toBe(1);
    expect(s.mean).toBe(-1.5);
    expect(s.sd).toBe(0);
    for (const v of [s.skew, s.kurtosis, s.outliers, s.se]) expect(Number.isFinite(v)).toBe(true);
    expect(s.skew).toBe(0);
    expect(s.kurtosis).toBe(0);
  });

  it("reads a long right tail as positive skew and a fat tailed set as positive excess kurtosis", () => {
    const tailed = summarize(collectMisses([
      scored("10180", "a, TX", 0, 0), scored("19100", "b, TX", 0, 0), scored("25980", "c, TX", 0, 0),
      scored("31080", "d, TX", 0, 0), scored("41860", "e, TX", 0, 12),
    ]))!;
    expect(tailed.skew).toBeGreaterThan(1);
    expect(tailed.kurtosis).toBeGreaterThan(0);
  });

  it("interpolates a quantile between the two order statistics around it", () => {
    expect(quantileOf([0, 10], 0.5)).toBe(5);
    expect(quantileOf([0, 1, 2, 3, 4], 0.25)).toBe(1);
    expect(quantileOf([7], 0.9)).toBe(7);
  });
});

describe("the metros the model missed by the most", () => {
  it("lists the biggest gap in each direction, worst first", () => {
    const { above, below } = extremes(collectMisses(EVEN), 2);
    expect(above.map((m) => m.surprise)).toEqual([2, 1]);
    expect(below.map((m) => m.surprise)).toEqual([-2, -1]);
  });

  it("never puts the same metro in both directions", () => {
    const { above, below } = extremes(collectMisses(EVEN), 8);
    const names = [...above, ...below].map((m) => m.cbsa);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps a metro the model overshot out of the list of metros that beat it", () => {
    // every metro here came in under, so there is nothing to put above
    const misses = collectMisses([
      scored("10180", "a, TX", 0, -1), scored("19100", "b, TX", 0, -2), scored("25980", "c, TX", 0, -3),
    ]);
    const { above, below } = extremes(misses, 8);
    expect(above).toEqual([]);
    expect(below.map((m) => m.surprise)).toEqual([-3, -2, -1]);
  });

  it("lists the one metro that was scored in whichever direction it went", () => {
    const { above, below } = extremes(collectMisses([scored("10180", "Abilene, TX", 2, -1)]), 5);
    expect(above).toEqual([]);
    expect(below.map((m) => m.cbsa)).toEqual(["10180"]);
  });

  it("counts a metro the model got exactly right in neither direction", () => {
    const { above, below } = extremes(collectMisses([scored("10180", "Abilene, TX", 2, 0)]), 5);
    expect([above, below]).toEqual([[], []]);
  });
});

describe("grouping the miss by state, which is what makes 410 metros fewer than 410 draws", () => {
  it("counts how many states missed the same way the country did", () => {
    const misses = collectMisses([
      scored("10180", "a, TX", 0, -2), scored("19100", "b, TX", 0, -1), scored("25980", "c, TX", 0, -3),
      scored("31080", "d, CA", 0, -1), scored("41860", "e, CA", 0, -2), scored("12060", "f, CA", 0, -4),
    ]);
    const spread = stateSpread(misses, 3)!;
    expect(spread.groups.map((g) => g.state).sort()).toEqual(["CA", "TX"]);
    expect(spread.agreeing).toBe(2);
  });

  it("leaves a state with too few metros out of the printed list without dropping it from the arithmetic", () => {
    const misses = collectMisses([
      scored("10180", "a, TX", 0, -2), scored("19100", "b, TX", 0, -1), scored("25980", "c, TX", 0, -3),
      scored("31080", "d, RI", 0, 6),
    ]);
    const spread = stateSpread(misses, 3)!;
    expect(spread.groups.map((g) => g.state)).toEqual(["TX"]);
    // the rhode island metro still moves the mean the states are judged against
    expect(spread.between).toBeGreaterThan(0);
  });

  it("puts all of the spread between the states when every state is internally identical", () => {
    const misses = collectMisses([
      scored("10180", "a, TX", 0, -2), scored("19100", "b, TX", 0, -2),
      scored("31080", "d, CA", 0, 2), scored("41860", "e, CA", 0, 2),
    ]);
    expect(stateSpread(misses, 2)!.between).toBeCloseTo(1, 10);
  });

  it("puts none of it between them when the states have the same mean", () => {
    const misses = collectMisses([
      scored("10180", "a, TX", 0, -2), scored("19100", "b, TX", 0, 2),
      scored("31080", "d, CA", 0, -2), scored("41860", "e, CA", 0, 2),
    ]);
    const spread = stateSpread(misses, 2)!;
    expect(spread.between).toBeCloseTo(0, 10);
    // and the clustered error collapses with it, because the states agree
    expect(spread.clusterSe).toBeCloseTo(0, 10);
  });

  it("widens the standard error of the mean once metros in a state are allowed to move together", () => {
    const misses = collectMisses([
      scored("10180", "a, TX", 0, -3), scored("19100", "b, TX", 0, -3),
      scored("31080", "d, CA", 0, 1), scored("41860", "e, CA", 0, 1),
    ]);
    const spread = stateSpread(misses, 2)!;
    expect(spread.clusterSe).toBeGreaterThan(summarize(misses)!.se);
  });
});

describe("fitting a line through a cloud of metros", () => {
  it("recovers the slope and intercept of points that sit exactly on a line", () => {
    const fit = fitLine([1, 2, 3, 4], [3, 5, 7, 9])!;
    expect(fit.slope).toBeCloseTo(2, 10);
    expect(fit.intercept).toBeCloseTo(1, 10);
    expect(fit.r).toBeCloseTo(1, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
    expect(fit.n).toBe(4);
  });

  it("reports no t statistic for a perfect fit rather than a very confident one", () => {
    expect(fitLine([1, 2, 3, 4], [3, 5, 7, 9])!.t).toBeNull();
  });

  it("refuses to fit fewer than three pairs, or a column that never varies", () => {
    expect(fitLine([1, 2], [1, 2])).toBeNull();
    expect(fitLine([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull();
    expect(fitLine([], [])).toBeNull();
  });

  it("keeps the rank correlation at one when the relationship is rising but bent", () => {
    const fit = fitLine([1, 2, 3, 4], [1, 4, 9, 16])!;
    expect(fit.rho).toBeCloseTo(1, 10);
    expect(fit.r).toBeLessThan(1);
  });

  it("averages the ranks of tied values so a run of equals does not order itself", () => {
    expect(ranksOf([5, 5, 9])).toEqual([1.5, 1.5, 3]);
    expect(ranksOf([9, 1, 5])).toEqual([3, 1, 2]);
  });
});

describe("binning metros by how loosely their index is measured", () => {
  it("splits them into equal groups and reports the typical miss inside each", () => {
    const misses = collectMisses([
      scored("10180", "a, TX", 0, 1, 0.1), scored("19100", "b, TX", 0, -1, 0.2),
      scored("25980", "c, TX", 0, 3, 0.8), scored("31080", "d, TX", 0, -5, 0.9),
    ]);
    const bins = errorBins(misses, 2);
    expect(bins.map((b) => b.n)).toEqual([2, 2]);
    expect(bins[0].meanAbs).toBeCloseTo(1, 10);
    expect(bins[1].meanAbs).toBeCloseTo(4, 10);
    // direction is a separate question from size, and the bins keep both
    expect(bins[0].meanSigned).toBeCloseTo(0, 10);
    expect(bins[1].meanSigned).toBeCloseTo(-1, 10);
  });

  it("ignores the metros that carry no standard error at all", () => {
    const misses = collectMisses([
      scored("10180", "a, TX", 0, 1, 0.1), scored("19100", "b, TX", 0, -1, 0.2),
      scored("25980", "c, TX", 0, 30),
    ]);
    const bins = errorBins(misses, 2);
    expect(bins.reduce((a, b) => a + b.n, 0)).toBe(2);
  });

  it("gives back no bins when there are fewer metros than bins to put them in", () => {
    expect(errorBins(collectMisses([scored("10180", "a, TX", 0, 1, 0.1)]), 4)).toEqual([]);
    expect(errorBins([], 4)).toEqual([]);
  });
});

describe("what the model is saying now", () => {
  it("reports the middle of the live calls and the width of the band around them", () => {
    const metros = [
      metro("10180", "a, TX", { hpi_forecast_4q: 2, hpi_forecast_4q_lo: -3, hpi_forecast_4q_hi: 7, hpi_forecast_8q: 5 }),
      metro("19100", "b, TX", { hpi_forecast_4q: 4, hpi_forecast_4q_lo: -2, hpi_forecast_4q_hi: 10, hpi_forecast_8q: 9 }),
      metro("25980", "c, TX", { hpi_forecast_4q: 6, hpi_forecast_4q_lo: 0, hpi_forecast_4q_hi: 12, hpi_forecast_8q: 13 }),
    ];
    const now = stance(metros)!;
    expect(now.n).toBe(3);
    expect(now.median).toBe(4);
    expect([now.min, now.max]).toEqual([2, 6]);
    expect(now.median8).toBe(9);
    expect(now.bandWidth).toBe(12);
    expect([now.bandMin, now.bandMax]).toEqual([10, 12]);
    expect(now.bandN).toBe(3);
  });

  it("counts a call whose band is half missing as a call without a band, not a band of zero", () => {
    const now = stance([metro("10180", "a, TX", { hpi_forecast_4q: 2, hpi_forecast_4q_lo: -3 })])!;
    expect(now.n).toBe(1);
    expect(now.bandWidth).toBeNull();
    expect([now.bandMin, now.bandMax]).toEqual([null, null]);
    expect(now.bandN).toBe(0);
  });
});

describe("the histogram of the miss", () => {
  it("counts every scored metro into a bin and puts the zero line on a bin edge", () => {
    const model = buildHistogram(collectMisses(EVEN), 400, 200, 1);
    expect(model.bars.reduce((a, b) => a + b.count, 0)).toBe(5);
    expect(model.domain).toEqual([-2, 3]);
    // -2 falls in the bin starting at -2, so the leftmost bar is not empty
    expect(model.bars[0].count).toBe(1);
    expect(model.bars.some((b) => b.from < 0 && b.to > 0)).toBe(false);
    expect(model.zeroX).toBeGreaterThan(model.left);
    expect(model.zeroX).toBeLessThan(model.right);
  });

  it("marks each bar with the direction it sits on, so the chart reads without its colours", () => {
    const model = buildHistogram(collectMisses(EVEN), 400, 200, 1);
    expect(model.bars.filter((b) => b.side === "over").every((b) => b.to <= 0)).toBe(true);
    expect(model.bars.filter((b) => b.side === "under").every((b) => b.from >= 0)).toBe(true);
  });

  it("draws every bar inside the plot with a finite position and height", () => {
    const model = buildHistogram(collectMisses(EVEN), 400, 200, 1);
    for (const bar of model.bars) {
      expect(Number.isFinite(bar.x) && Number.isFinite(bar.y) && Number.isFinite(bar.h)).toBe(true);
      expect(bar.y).toBeGreaterThanOrEqual(model.top - 0.01);
      expect(bar.h).toBeGreaterThanOrEqual(0);
    }
    expect(model.meanX).not.toBeNull();
    expect(model.medianX).not.toBeNull();
  });

  it("draws nothing at all, and no bars, when no metro was scored", () => {
    const model = buildHistogram([], 400, 200, 1);
    expect(model.bars).toEqual([]);
    expect(model.peak).toBe(0);
    expect(model.meanX).toBeNull();
    expect(histogramTitle(null)).toContain("no scored forecasts");
  });

  it("still draws one metro, by opening a bin either side of it", () => {
    const model = buildHistogram(collectMisses([scored("10180", "a, TX", 2, -1)]), 400, 200, 1);
    expect(model.bars.reduce((a, b) => a + b.count, 0)).toBe(1);
    expect(model.domain[0]).toBeLessThan(model.domain[1]);
  });

  it("finds the bar under a horizontal position, and nothing outside the plot", () => {
    const model = buildHistogram(collectMisses(EVEN), 400, 200, 1);
    const bar = model.bars[2];
    expect(barAt(model, bar.x + bar.w / 2)).toBe(bar);
    expect(barAt(model, model.left - 20)).toBeNull();
    expect(barAt(buildHistogram([], 400, 200, 1), 50)).toBeNull();
  });

  it("tells a reader who cannot see it where the middle metro landed", () => {
    const title = histogramTitle(summarize(collectMisses(EVEN)));
    expect(title).toContain("5 metros");
    expect(title).toContain("-1.0 and 1.0");
  });
});

describe("the miss against the index standard error", () => {
  it("plots only the metros that carry an error, and fits a line through them", () => {
    const misses = collectMisses([
      scored("10180", "a, TX", 0, 1, 0.2), scored("19100", "b, TX", 0, -2, 0.4),
      scored("25980", "c, TX", 0, 3, 0.6), scored("31080", "d, TX", 0, -4, 0.8),
      scored("41860", "e, TX", 0, 9),
    ]);
    const model = buildScatter(misses, 400, 200);
    expect(model.points).toHaveLength(4);
    expect(model.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(model.fit!.n).toBe(4);
    expect(model.fit!.slope).toBeGreaterThan(0);
    expect(model.fitD).toContain("M ");
  });

  it("carries the binned means as well as the dots, so the middle of the cloud is visible", () => {
    const misses = collectMisses([
      scored("10180", "a, TX", 0, 1, 0.2), scored("19100", "b, TX", 0, -1, 0.4),
      scored("25980", "c, TX", 0, 5, 0.6), scored("31080", "d, TX", 0, -5, 0.8),
    ]);
    const model = buildScatter(misses, 400, 200);
    expect(model.marks).toHaveLength(4);
    for (const mark of model.marks) expect(Number.isFinite(mark.x) && Number.isFinite(mark.y)).toBe(true);
  });

  it("draws an empty plot when no scored metro carries a standard error", () => {
    const model = buildScatter(collectMisses([scored("10180", "a, TX", 0, 4)]), 400, 200);
    expect(model.points).toEqual([]);
    expect(model.fit).toBeNull();
    expect(model.fitD).toBe("");
    expect(scatterTitle(model)).toContain("no index standard errors");
  });

  it("draws an empty plot for an empty metro list", () => {
    const model = buildScatter([], 400, 200);
    expect(model.points).toEqual([]);
    expect(model.marks).toEqual([]);
  });

  it("finds the metro nearest a point, and nothing at all on an empty plot", () => {
    const misses = collectMisses([
      scored("10180", "a, TX", 0, 1, 0.2), scored("19100", "b, TX", 0, -8, 3.5),
    ]);
    const model = buildScatter(misses, 400, 200);
    const far = model.points[1];
    expect(nearestMetro(model, far.x, far.y)!.cbsa).toBe("19100");
    expect(nearestMetro(buildScatter([], 400, 200), 10, 10)).toBeNull();
  });
});

describe("the box the charts are drawn in", () => {
  it("gives a phone a narrower plot and wider bins than a desktop", () => {
    expect(chartBox("phone").width).toBeLessThan(chartBox("wide").width);
    expect(chartBox("phone").step).toBeGreaterThan(chartBox("wide").step);
  });

  it("gives every viewport mode a plot with room inside its padding", () => {
    for (const mode of ["phone", "tablet", "compact", "wide"] as const) {
      const size = chartBox(mode);
      const model = buildHistogram(collectMisses(EVEN), size.width, size.height, size.step);
      expect(model.right, mode).toBeGreaterThan(model.left);
      expect(model.bottom, mode).toBeGreaterThan(model.top);
    }
  });
});

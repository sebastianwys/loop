import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildHistory, forecastLevels, forecastOf, hoverables, nearestPoint, niceTicks, yearTicks, type ForecastInput } from "./history";
import { SAMPLE } from "./data";
import type { AnnualSeries, MapData, Metro } from "../types";

const abilene = SAMPLE.metros[0];
const dallas = SAMPLE.metros[1];
const sparse = SAMPLE.metros[2];

const full: ForecastInput = { mid4: 3.1, mid8: 6.0, lo4: -1.2, hi4: 7.0, lo8: -2.5, hi8: 14.2 };
const flat: AnnualSeries = { start: 2014, values: [100, 110, 120], as_of: "2016-06" };

describe("forecastLevels", () => {
  it("grows the last level by each percent, one and two years out", () => {
    const levels = forecastLevels({ year: 2026, value: 300 }, full);
    expect(levels.map((l) => l.year)).toEqual([2027, 2028]);
    expect(levels[0].mid).toBeCloseTo(300 * 1.031, 6);
    expect(levels[0].lo).toBeCloseTo(300 * 0.988, 6);
    expect(levels[0].hi).toBeCloseTo(300 * 1.07, 6);
    expect(levels[1].mid).toBeCloseTo(318, 6);
    expect(levels[1].lo).toBeCloseTo(300 * 0.975, 6);
    expect(levels[1].hi).toBeCloseTo(300 * 1.142, 6);
  });

  it("drops a year without a median and a band with a missing edge", () => {
    expect(forecastLevels({ year: 2026, value: 300 }, { ...full, mid4: null })).toMatchObject([{ year: 2028, mid: 318 }]);
    const halfBand = forecastLevels({ year: 2026, value: 300 }, { ...full, hi4: null });
    expect(halfBand[0]).toMatchObject({ lo: null, hi: null });
    expect(halfBand[1].lo).not.toBeNull();
    expect(forecastLevels({ year: 2026, value: 300 }, null)).toEqual([]);
  });

  it("reads the six fields from a metro and is null without a point", () => {
    expect(forecastOf(abilene)).toEqual(full);
    expect(forecastOf(sparse)).toBeNull();
    expect(forecastOf({} as Metro)).toBeNull();
    expect(forecastOf({ ...dallas, latest: { ...dallas.latest, hpi_forecast_4q: null } } as Metro)?.mid8).toBe(1.5);
  });
});

describe("ticks", () => {
  it("bracket the data with round steps", () => {
    expect(niceTicks(186.9, 312.4)).toEqual([150, 200, 250, 300, 350]);
    expect(niceTicks(186.9, 356.8)).toEqual([150, 200, 250, 300, 350, 400]);
    expect(niceTicks(100, 120)).toEqual([100, 105, 110, 115, 120]);
    expect(niceTicks(100, 120, 2)).toEqual([100, 110, 120]);
    expect(niceTicks(0.12, 0.31)).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35]);
    expect(niceTicks(7, 7)).toEqual([6, 7, 8]);
    expect(niceTicks(Number.NaN, 1)).toEqual([]);
  });

  it("pick whole years at a step that fits the budget", () => {
    expect(yearTicks(2014, 2028)).toEqual([2014, 2016, 2018, 2020, 2022, 2024, 2026, 2028]);
    expect(yearTicks(2014, 2026)).toEqual([2014, 2016, 2018, 2020, 2022, 2024, 2026]);
    expect(yearTicks(2014, 2016)).toEqual([2014, 2015, 2016]);
    expect(yearTicks(2000, 2040, 5)).toEqual([2000, 2010, 2020, 2030, 2040]);
    expect(yearTicks(2016, 2014)).toEqual([]);
  });
});

describe("buildHistory", () => {
  it("scales years across the plot and values between round ticks", () => {
    const h = buildHistory(flat, null, 320, 140);
    expect(h.points.map((p) => p.year)).toEqual([2014, 2015, 2016]);
    expect(h.points[0].x).toBe(h.left);
    expect(h.points[2].x).toBe(h.right);
    expect(h.points[1].x).toBeCloseTo((h.left + h.right) / 2, 0);
    expect(h.values).toEqual([100, 120]);
    expect(h.points[0].y).toBe(h.bottom);
    expect(h.points[2].y).toBe(h.top);
    expect(h.d).toBe(`M ${h.points[0].x} ${h.points[0].y} L ${h.points[1].x} ${h.points[1].y} L ${h.points[2].x} ${h.points[2].y}`);
    expect(h.last).toEqual(h.points[2]);
    expect(h.forecast).toEqual([]);
    expect(h.forecastD).toBe("");
    expect(h.bandD).toBe("");
    expect(h.xTicks.map((t) => t.year)).toEqual([2014, 2015, 2016]);
    expect(h.yTicks.map((t) => t.value)).toEqual([100, 105, 110, 115, 120]);
  });

  it("extends two years past the last point with the median path and a closed band", () => {
    const series: AnnualSeries = { start: 2024, values: [280, 290, 300], as_of: "2026-06" };
    const h = buildHistory(series, full, 320, 140);
    expect(h.years).toEqual([2024, 2028]);
    expect(h.forecast.map((p) => p.year)).toEqual([2027, 2028]);
    expect(h.forecast[0].value).toBeCloseTo(309.3, 6);
    expect(h.forecast[1].value).toBeCloseTo(318, 6);
    expect(h.forecast[1].x).toBe(h.right);
    expect(h.last!.x).toBeCloseTo(h.left + (h.right - h.left) / 2, 0);
    expect(h.forecastD).toBe(`M ${h.last!.x} ${h.last!.y} L ${h.forecast[0].x} ${h.forecast[0].y} L ${h.forecast[1].x} ${h.forecast[1].y}`);
    expect(h.bandD.startsWith(`M ${h.last!.x} ${h.last!.y} L ${h.forecast[0].x} ${h.forecast[0].yHi}`)).toBe(true);
    expect(h.bandD.endsWith(`L ${h.forecast[0].x} ${h.forecast[0].yLo} Z`)).toBe(true);
    expect(h.forecast[0].yHi!).toBeLessThan(h.forecast[0].y);
    expect(h.forecast[0].yLo!).toBeGreaterThan(h.forecast[0].y);
    expect(h.values[1]).toBeGreaterThanOrEqual(300 * 1.142);
    expect(h.values[0]).toBeLessThanOrEqual(280);
  });

  it("draws the path without a band when an edge is missing", () => {
    const h = buildHistory(flat, { ...full, lo4: null, lo8: null }, 320, 140);
    expect(h.forecast).toHaveLength(2);
    expect(h.forecastD).not.toBe("");
    expect(h.bandD).toBe("");
  });

  it("leaves a gap at a null and starts the forecast from the last present value", () => {
    const gappy: AnnualSeries = { start: 2014, values: [100, null, 120, 130, null], as_of: "2018-03" };
    const h = buildHistory(gappy, full, 320, 140);
    expect(h.points.map((p) => p.year)).toEqual([2014, 2016, 2017]);
    expect(h.d).toBe(`M ${h.points[1].x} ${h.points[1].y} L ${h.points[2].x} ${h.points[2].y}`);
    expect(h.last!.year).toBe(2017);
    expect(h.forecast.map((p) => p.year)).toEqual([2018, 2019]);
    expect(h.years).toEqual([2014, 2019]);
  });

  it("is empty for all nulls and centers a single value", () => {
    const none = buildHistory({ start: 2014, values: [null, null], as_of: "2015" }, full);
    expect(none.points).toEqual([]);
    expect(none.last).toBeNull();
    expect(none.d).toBe("");
    const one = buildHistory({ start: 2020, values: [250], as_of: "2020" }, null, 320, 140);
    expect(one.points[0].x).toBeCloseTo((one.left + one.right) / 2, 1);
    expect(one.values).toEqual([249, 251]);
    expect(Number.isFinite(one.points[0].y)).toBe(true);
  });

  it("never produces nan for constant values", () => {
    const h = buildHistory({ start: 2014, values: [5, 5, 5], as_of: "2016" }, null);
    for (const p of h.points) expect(Number.isFinite(p.y)).toBe(true);
    expect(h.yTicks.map((t) => t.value)).toEqual([4, 5, 6]);
    expect(h.points.every((p) => p.y === (h.top + h.bottom) / 2)).toBe(true);
  });
});

describe("hover", () => {
  const h = buildHistory({ start: 2024, values: [280, 290, 300], as_of: "2026-06" }, full, 320, 140);

  it("snaps to the nearest history or forecast point by x", () => {
    expect(nearestPoint(h, h.left - 30)).toMatchObject({ kind: "history", point: { year: 2024 } });
    expect(nearestPoint(h, h.points[1].x + 3)).toMatchObject({ kind: "history", point: { year: 2025 } });
    expect(nearestPoint(h, h.right + 50)).toMatchObject({ kind: "forecast", point: { year: 2028 } });
    expect(nearestPoint(buildHistory({ start: 2014, values: [null], as_of: "2014" }, null), 10)).toBeNull();
  });

  it("lists every point in year order for keyboard stepping", () => {
    expect(hoverables(h).map((v) => v.point.year)).toEqual([2024, 2025, 2026, 2027, 2028]);
    expect(hoverables(h).map((v) => v.kind)).toEqual(["history", "history", "history", "forecast", "forecast"]);
  });
});

// the shipped map file and the fhfa quarterly master the bot builds it from.
// both are optional in ci, so this block skips when either is absent
const MAP_PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const FHFA_PATH = new URL("../../../data/raw/fhfa/hpi_master.csv", import.meta.url).pathname;
const REAL = existsSync(MAP_PATH) && existsSync(FHFA_PATH);

// the index level one quarter carries in the source fhfa file, the same
// series bot/build_map_data.py averages into the annual history
function fhfaQuarterLevel(cbsa: string, year: number, quarter: number): number {
  const tail = `,${cbsa},${year},${quarter},`;
  const row = readFileSync(FHFA_PATH, "utf8")
    .split("\n")
    .find((r) => r.startsWith("traditional,all-transactions,quarterly,MSA,") && r.includes(tail));
  if (!row) throw new Error(`no fhfa row for ${cbsa} ${year}Q${quarter}`);
  return Number(row.slice(row.indexOf(tail) + tail.length).split(",")[0]);
}

describe.skipIf(!REAL)("expected levels on the built data", () => {
  it("compounds the model growth onto the origin quarter level, not the partial year mean", () => {
    const map = JSON.parse(readFileSync(MAP_PATH, "utf8")) as MapData;
    const metro = map.metros.find((m) => m.cbsa === "10180");
    const series = metro?.series?.hpi;
    if (!metro || !series) throw new Error("abilene has no hpi series in the built map");

    // the model wrote its percents at the origin quarter, 2026q2
    expect(series.as_of).toBe("2026Q2");
    expect(metro.latest.hpi_forecast_4q_date).toBe("2026-06");

    // 2026 is a partial year: its annual value is the mean of q1 and q2, well
    // below the q2 level the growth was measured from
    expect(series.values[series.values.length - 1]).toBe(370);
    const origin = fhfaQuarterLevel("10180", 2026, 2);
    expect(origin).toBe(381.69);

    const f = forecastOf(metro);
    if (!f || f.mid4 === null || f.lo4 === null || f.hi4 === null) throw new Error("abilene has no four quarter forecast");
    expect(f.mid4).toBe(5.698);

    const one = buildHistory(series, f).forecast[0];
    expect(one.year).toBe(2027);
    // 381.69 grown by 5.698, -3.3277 and 16.1856 percent
    expect(one.value).toBeCloseTo(origin * (1 + f.mid4 / 100), 4);
    expect(one.lo).toBeCloseTo(origin * (1 + f.lo4 / 100), 4);
    expect(one.hi).toBeCloseTo(origin * (1 + f.hi4 / 100), 4);
    // what the detail panel prints, to one decimal
    expect(Math.round(one.value * 10) / 10).toBe(403.4);
  });
});

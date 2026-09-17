import { describe, expect, it } from "vitest";
import { SAMPLE } from "./data";
import {
  CHART_H, CHART_PAD, CHART_W, DETAIL_ID, INDICATOR_GROUPS, MORTGAGE_ID, activeRangeId, buildIndicatorChart, changeChip,
  chartTitle, clipHistory, displayFormat, groupIndicators, groupId, historySpan, indicatorRanges, indicatorSpark,
  indicatorValue, monthLabel, nationalIndicators, nearestChartPoint, pointReadout, rangeLabel, rangeMonths,
  readIndicator, showMortgageStat, sourceLine, tileId, tileReadout,
} from "./indicators";
import type { Indicator, IndicatorPoint, MapData, MortgageRate } from "../types";

const points = (values: number[], from = 1): IndicatorPoint[] =>
  values.map((value, i) => ({ date: `2026-${String(from + i).padStart(2, "0")}`, value }));

// a run of calendar months from a start, leaving out any month the source
// never published, the way a real series carries a hole
const monthly = (start: string, months: number, absent: string[] = []): IndicatorPoint[] => {
  const [year, month] = start.split("-").map(Number);
  const out: IndicatorPoint[] = [];
  for (let k = 0; k < months; k += 1) {
    const slot = year * 12 + month - 1 + k;
    const date = `${Math.floor(slot / 12)}-${String((slot % 12) + 1).padStart(2, "0")}`;
    if (!absent.includes(date)) out.push({ date, value: 2 + k / 10 });
  }
  return out;
};

// a build with only a national block, for the shapes the reader must survive
const built = (national: unknown): MapData => ({ national } as unknown as MapData);

const make = (over: Partial<Indicator> = {}): Indicator => ({
  id: "cpi",
  label: "CPI, all items",
  group: "Prices",
  format: "pct",
  provider: "BLS via FRED",
  note: "The change in consumer prices over the last twelve months.",
  value: 2.9,
  date: "2026-08",
  change_12m: 0.4,
  history: points([2.5, 2.7, 2.9]),
  ...over,
});

const fixture = nationalIndicators(SAMPLE);
const byId = (id: string) => fixture.find((i) => i.id === id)!;

describe("reading the block", () => {
  it("is empty when the build carries no indicators", () => {
    expect(nationalIndicators(null)).toEqual([]);
    expect(nationalIndicators(undefined)).toEqual([]);
    expect(nationalIndicators({} as MapData)).toEqual([]);
    expect(nationalIndicators(built({ mortgage_rate: null }))).toEqual([]);
    expect(nationalIndicators(built({ mortgage_rate: null, indicators: [] }))).toEqual([]);
    expect(nationalIndicators(built({ mortgage_rate: null, indicators: "soon" }))).toEqual([]);
  });

  it("drops an entry that is missing what a tile needs", () => {
    expect(readIndicator(null)).toBeNull();
    expect(readIndicator({ id: "", group: "Prices", value: 1 })).toBeNull();
    expect(readIndicator({ id: "cpi", group: "Prices", value: null })).toBeNull();
    expect(readIndicator({ id: "cpi", group: "Prices", value: Number.NaN })).toBeNull();
    expect(readIndicator({ id: "cpi", group: "Weather", value: 1 })).toBeNull();
  });

  it("fills the soft fields and keeps only usable history points", () => {
    const read = readIndicator({
      id: "ppi",
      group: "Prices",
      value: 2.2,
      history: [{ date: "2026-07", value: 2.1 }, { date: "2026-08", value: null }, { date: "", value: 3 }, 7],
    })!;
    expect(read.label).toBe("ppi");
    expect(read.format).toBe("pct");
    expect(read.provider).toBe("");
    expect(read.change_12m).toBeNull();
    expect(read.history).toEqual([{ date: "2026-07", value: 2.1 }]);
  });

  it("reads the thirteen indicators the sample carries", () => {
    expect(fixture).toHaveLength(13);
    expect(byId("cpi").value).toBe(2.9);
    expect(byId("mortgage").format).toBe("rate");
    expect(byId("sentiment").group).toBe("Consumers");
    for (const indicator of fixture) expect(indicator.history.length).toBeGreaterThan(1);
  });
});

describe("groups", () => {
  it("keeps the fixed order whatever order the json is in", () => {
    const mixed = [
      make({ id: "sentiment", group: "Consumers" }),
      make({ id: "fed_funds", group: "Rates" }),
      make({ id: "cpi", group: "Prices" }),
      make({ id: "ppi", group: "Prices" }),
    ];
    const blocks = groupIndicators(mixed);
    expect(blocks.map((b) => b.group)).toEqual(INDICATOR_GROUPS);
    expect(blocks[0].indicators.map((i) => i.id)).toEqual(["cpi", "ppi"]);
    expect(blocks[2].indicators.map((i) => i.id)).toEqual(["sentiment"]);
  });

  it("leaves out a group with nothing in it", () => {
    expect(groupIndicators([])).toEqual([]);
    expect(groupIndicators([make({ group: "Rates" })]).map((b) => b.group)).toEqual(["Rates"]);
  });

  it("groups the sample into prices, rates and consumers", () => {
    expect(groupIndicators(fixture).map((b) => [b.group, b.indicators.length])).toEqual([
      ["Prices", 5],
      ["Rates", 4],
      ["Consumers", 4],
    ]);
  });

  it("names the ids the tiles and the one detail row use", () => {
    expect(groupId("Prices")).toBe("indicator-group-prices");
    expect(tileId("core_cpi")).toBe("indicator-tile-core_cpi");
    expect(DETAIL_ID).toBe("national-indicator-detail");
  });
});

describe("the displayed value", () => {
  it("prints a percent that is already in display units without scaling it", () => {
    expect(displayFormat("pct")).toBe("rate");
    expect(displayFormat("rate")).toBe("rate");
    expect(displayFormat("index")).toBe("index");
    expect(indicatorValue(make({ value: 2.9 }))).toBe("2.9%");
    expect(indicatorValue(make({ format: "rate", value: 6.76 }))).toBe("6.8%");
    expect(indicatorValue(make({ format: "index", value: 58.24 }))).toBe("58.2");
  });
});

describe("the change chip", () => {
  it("signs a rise and names the direction", () => {
    expect(changeChip(0.4)).toMatchObject({ direction: "up", text: "+0.4 pts", word: "up" });
    expect(changeChip(0.4).label).toBe("up 0.4 pts over twelve months");
  });

  it("signs a fall without a second minus in the size", () => {
    expect(changeChip(-1.25)).toMatchObject({ direction: "down", text: "-1.3 pts", word: "down" });
    expect(changeChip(-0.75).text).toBe("-0.8 pts");
  });

  it("reads exactly zero as no change, never as a signed zero", () => {
    const chip = changeChip(0);
    expect(chip.text).toBe("no change");
    expect(chip.direction).toBe("flat");
    expect(chip.word).toBe("");
    expect(chip.text).not.toContain("0.0");
  });

  it("reads a change too small to print as no change", () => {
    expect(changeChip(0.04).text).toBe("no change");
    expect(changeChip(-0.04).text).toBe("no change");
    expect(changeChip(0.05).text).toBe("+0.1 pts");
  });

  it("says so when there is no twelve month figure", () => {
    for (const missing of [null, undefined, Number.NaN]) {
      const chip = changeChip(missing as number | null);
      expect(chip.direction).toBe("none");
      expect(chip.text).toBe("not reported");
      expect(chip.label).toBe("twelve month change not reported");
    }
  });
});

describe("dates", () => {
  it("names the month a value is for", () => {
    expect(monthLabel("2026-08")).toBe("Aug 2026");
    expect(monthLabel("")).toBe("");
    expect(monthLabel(null)).toBe("");
  });

  it("names the span a history covers", () => {
    expect(rangeLabel([])).toBe("");
    expect(rangeLabel(points([2.9], 8))).toBe("Aug 2026");
    expect(rangeLabel(points([2.5, 2.7, 2.9], 6))).toBe("Jun 2026 to Aug 2026");
    expect(rangeLabel(byId("cpi").history)).toBe("Sep 2023 to Aug 2026");
  });
});

describe("the sparkline", () => {
  it("draws nothing at all below two points", () => {
    expect(indicatorSpark([])).toBeNull();
    expect(indicatorSpark(points([2.9]))).toBeNull();
  });

  it("draws one line through the points at the tile size", () => {
    const spark = indicatorSpark(points([2.5, 2.7, 2.9]))!;
    expect(spark.width).toBe(80);
    expect(spark.height).toBe(24);
    expect(spark.d).toMatch(/^M [\d.]+ [\d.]+ L /);
    expect(spark.points).toHaveLength(3);
    expect(spark.points[2].y).toBeLessThan(spark.points[0].y);
  });

  it("puts the newest point at the right hand edge", () => {
    const spark = indicatorSpark(points([1, 2, 3]))!;
    expect(spark.points[2].x).toBeGreaterThan(spark.points[0].x);
    expect(spark.points[2].x).toBe(77);
  });
});

describe("the expanded chart", () => {
  const chart = buildIndicatorChart(points([2.5, 2.7, 2.6, 2.9]), 400)!;

  it("needs two points, like the sparkline", () => {
    expect(buildIndicatorChart([], 400)).toBeNull();
    expect(buildIndicatorChart(points([2.9]), 400)).toBeNull();
  });

  it("carries the dates, the line and the range of the values", () => {
    expect(chart.width).toBe(400);
    expect(chart.height).toBe(CHART_H);
    expect(chart.points.map((p) => p.date)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(chart.last).toMatchObject({ date: "2026-04", value: 2.9 });
    expect(chart.values).toEqual([2.5, 2.9]);
    expect(chart.d).toContain(" L ");
  });

  it("finds the point nearest the pointer", () => {
    expect(nearestChartPoint(chart, -50)!.date).toBe("2026-01");
    expect(nearestChartPoint(chart, 9999)!.date).toBe("2026-04");
    const mid = chart.points[1];
    expect(nearestChartPoint(chart, mid.x + 2)!.date).toBe("2026-02");
    expect(nearestChartPoint(null, 10)).toBeNull();
  });

  it("reads a point out as a month and a value", () => {
    expect(pointReadout(chart.points[1], "pct")).toBe("Feb 2026: 2.7%");
    expect(pointReadout(chart.points[1], "index")).toBe("Feb 2026: 2.7");
  });
});

describe("a month the source never published", () => {
  // the shipped national cpi shape: every month from aug 2021 to aug 2026
  // except oct 2025, which the shutdown cost, so 61 slots carry 60 points
  const shipped = () => monthly("2021-08", 61, ["2025-10"]);

  it("gives every calendar month a slot, present or not", () => {
    const history = shipped();
    expect(history).toHaveLength(60);
    const chart = buildIndicatorChart(history)!;
    // 61 slots means 60 steps across the drawable width
    const step = (CHART_W - 2 * CHART_PAD) / 60;
    expect(step).toBe(11.6);
    expect(chart.points).toHaveLength(60);
    expect(chart.points[1].x - chart.points[0].x).toBeCloseTo(step, 6);
    expect(chart.last.x - chart.points[0].x).toBeCloseTo(CHART_W - 2 * CHART_PAD, 6);
  });

  it("draws the two month move at two months of width", () => {
    const chart = buildIndicatorChart(shipped())!;
    const step = (CHART_W - 2 * CHART_PAD) / 60;
    const before = chart.points.findIndex((p) => p.date === "2025-09");
    expect(before).toBe(49);
    expect(chart.points[before + 1].date).toBe("2025-11");
    expect(chart.points[before + 1].x - chart.points[before].x).toBeCloseTo(2 * step, 6);
    expect(chart.last.date).toBe("2026-08");
  });

  it("breaks the path at the hole instead of drawing one unbroken run", () => {
    const chart = buildIndicatorChart(shipped())!;
    // 50 months, then a break, then 10 more
    expect(chart.d.match(/M /g)).toHaveLength(2);
    expect(chart.d.match(/L /g)).toHaveLength(58);
  });

  it("keeps the months in step on both sides of a short gap", () => {
    const history = monthly("2026-01", 5, ["2026-03"]);
    expect(history.map((p) => p.date)).toEqual(["2026-01", "2026-02", "2026-04", "2026-05"]);
    const spark = indicatorSpark(history)!;
    expect(spark.points.map((p) => p.index)).toEqual([0, 1, 3, 4]);
    const chart = buildIndicatorChart(history, 400)!;
    expect(chart.points.map((p) => p.date)).toEqual(["2026-01", "2026-02", "2026-04", "2026-05"]);
    // 5 slots means 4 steps of 94px across the drawable width
    const step = (400 - 2 * CHART_PAD) / 4;
    expect(step).toBe(94);
    expect(chart.points[1].x - chart.points[0].x).toBeCloseTo(step, 6);
    expect(chart.points[2].x - chart.points[1].x).toBeCloseTo(2 * step, 6);
    expect(chart.points[3].x - chart.points[2].x).toBeCloseTo(step, 6);
    expect(chart.d.match(/M /g)).toHaveLength(2);
    expect(chart.d.match(/L /g)).toHaveLength(2);
  });
});

describe("the span the chart shows", () => {
  // three shapes the build can arrive in: a treasury series that runs for
  // decades, a ppi one that starts in 2010, and the five years the current
  // file carries. all three end in aug 2026
  const deep = () => monthly("1996-01", 368);
  const short = () => monthly("2010-11", 190);
  const five = () => monthly("2021-09", 60);

  it("counts the calendar months a history covers, not the points in it", () => {
    expect(historySpan([])).toBe(0);
    expect(historySpan(points([2.9]))).toBe(1);
    expect(historySpan(five())).toBe(60);
    // the month the source never published still takes up its place
    expect(historySpan(monthly("2026-01", 5, ["2026-03"]))).toBe(5);
  });

  it("offers no span at all for a history too short to draw", () => {
    expect(indicatorRanges([])).toEqual([]);
    expect(indicatorRanges(points([2.9]))).toEqual([]);
  });

  it("offers a span only while the series reaches that far back", () => {
    expect(indicatorRanges(deep()).map((r) => r.id)).toEqual(["1y", "5y", "10y", "25y", "max"]);
    // sixteen years of ppi never gets a twenty five year button
    expect(indicatorRanges(short()).map((r) => r.id)).toEqual(["1y", "5y", "10y", "max"]);
  });

  it("leaves out a span that would draw the whole history a second time", () => {
    expect(indicatorRanges(five()).map((r) => r.id)).toEqual(["1y", "max"]);
    expect(indicatorRanges(monthly("2025-09", 12)).map((r) => r.id)).toEqual(["max"]);
  });

  it("drops a span that a gap has left with one point in it", () => {
    // dense through aug 2024, then nothing until one lone month in aug 2026
    const gappy = [...monthly("2009-01", 188), { date: "2026-08", value: 9 }];
    expect(historySpan(gappy)).toBe(212);
    expect(clipHistory(gappy, 12)).toHaveLength(1);
    expect(indicatorRanges(gappy).map((r) => r.id)).toEqual(["5y", "10y", "max"]);
  });

  it("names every span with the months it really draws", () => {
    const ranges = indicatorRanges(short());
    expect(ranges[0]).toMatchObject({ label: "1y", months: 12, readout: "1y, Sep 2025 to Aug 2026" });
    expect(ranges[3]).toMatchObject({ label: "Max", months: null, readout: "Max, Nov 2010 to Aug 2026" });
  });

  it("keeps the last months of a history, counted on the calendar", () => {
    const shown = clipHistory(monthly("2024-01", 32, ["2026-02"]), 12);
    expect(shown[0].date).toBe("2025-09");
    expect(shown[shown.length - 1].date).toBe("2026-08");
    // twelve slots, one of which the source never published
    expect(shown).toHaveLength(11);
  });

  it("gives back the whole history when the span is longer than the series", () => {
    const history = five();
    expect(clipHistory(history, null)).toBe(history);
    expect(clipHistory(history, 600)).toEqual(history);
    expect(clipHistory([], 12)).toEqual([]);
    expect(clipHistory(points([2.9]), 12)).toEqual(points([2.9]));
  });

  it("counts points instead when a month cannot be read as a date", () => {
    const odd = [{ date: "2026-13", value: 1 }, ...points([2.7, 2.9], 7)];
    expect(clipHistory(odd, 2).map((p) => p.date)).toEqual(["2026-07", "2026-08"]);
  });

  it("opens at five years, or at the whole history when that is shorter", () => {
    expect(activeRangeId(indicatorRanges(deep()), null)).toBe("5y");
    expect(activeRangeId(indicatorRanges(short()), null)).toBe("5y");
    expect(activeRangeId(indicatorRanges(five()), null)).toBe("max");
    expect(activeRangeId([], null)).toBe("max");
  });

  it("drops a chosen span the next series cannot fill", () => {
    expect(activeRangeId(indicatorRanges(deep()), "25y")).toBe("25y");
    expect(activeRangeId(indicatorRanges(short()), "25y")).toBe("5y");
    expect(activeRangeId(indicatorRanges(five()), "10y")).toBe("max");
  });

  it("reads the months behind a span, and the whole history for an unknown one", () => {
    const ranges = indicatorRanges(deep());
    expect(rangeMonths(ranges, "10y")).toBe(120);
    expect(rangeMonths(ranges, "max")).toBeNull();
    expect(rangeMonths(ranges, "50y")).toBeNull();
    expect(rangeMonths([], "5y")).toBeNull();
  });

  it("draws the window across the whole width instead of a stretched history", () => {
    const chart = buildIndicatorChart(clipHistory(deep(), 60), 400)!;
    expect(chart.points).toHaveLength(60);
    expect(chart.points[0].date).toBe("2021-09");
    expect(chart.last.date).toBe("2026-08");
    // sixty months means fifty nine steps across the drawable width, and a
    // coordinate is rounded to a tenth, so the step is read at that precision
    const step = (400 - 2 * CHART_PAD) / 59;
    expect(chart.points[1].x - chart.points[0].x).toBeCloseTo(step, 1);
    expect(chart.last.x - chart.points[0].x).toBeCloseTo(400 - 2 * CHART_PAD, 6);
  });

  it("names the window the chart draws, and the whole run everywhere else", () => {
    const indicator = make({ history: deep() });
    expect(chartTitle(indicator)).toBe("CPI, all items, monthly, Jan 1996 to Aug 2026");
    expect(chartTitle(indicator, clipHistory(indicator.history, 60))).toBe("CPI, all items, monthly, Sep 2021 to Aug 2026");
    // the tile is not part of the bargain: its figure and its sparkline
    // still read the whole history, whatever the chart is showing
    expect(indicatorSpark(indicator.history)!.points).toHaveLength(368);
    expect(changeChip(indicator.change_12m).text).toBe("+0.4 pts");
    expect(sourceLine(indicator)).toBe("BLS via FRED, monthly, Jan 1996 to Aug 2026");
  });
});

describe("the words around a tile", () => {
  it("reads a tile out in full", () => {
    expect(tileReadout(make())).toBe("CPI, all items, 2.9% in Aug 2026, up 0.4 pts over twelve months");
    expect(tileReadout(make({ date: "", change_12m: null }))).toBe("CPI, all items, 2.9%, twelve month change not reported");
  });

  it("names the chart and the span it covers", () => {
    expect(chartTitle(make({ history: points([2.5, 2.9], 7) }))).toBe("CPI, all items, monthly, Jul 2026 to Aug 2026");
    expect(chartTitle(make({ history: [] }))).toBe("CPI, all items");
  });

  it("names the provider and the months under the chart", () => {
    expect(sourceLine(byId("core_pce"))).toBe("BEA via FRED, monthly, Sep 2023 to Aug 2026");
    expect(sourceLine(make({ provider: "", history: [] }))).toBe("source not named");
  });
});

describe("the standalone mortgage stat", () => {
  const rate = SAMPLE.national.mortgage_rate as MortgageRate;

  it("stays while the strip has no mortgage tile", () => {
    expect(showMortgageStat(rate, [])).toBe(true);
    expect(showMortgageStat(rate, [make({ id: "cpi" })])).toBe(true);
  });

  it("goes away once a tile carries the same rate", () => {
    expect(showMortgageStat(rate, fixture)).toBe(false);
    expect(showMortgageStat(rate, [make({ id: MORTGAGE_ID })])).toBe(false);
    expect(showMortgageStat(null, [])).toBe(false);
  });
});

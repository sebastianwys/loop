import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AXIS_MIN_END, AXIS_START, AXIS_WIDTH, DEEP_DEFS, axisEnd, buildDeepTimeline, buildTimeline, changeSpan, dateLabel,
  dateToYear, deepCaption, frameAt, frameIndex, frameName, frameText, growthAt, isYearMetric, laterStartsNote,
  latestColumn, latestDate, levelAt, newestYear, nextFrame, nextPeriod, periodCounts, periodLabel, prevPeriod,
  publishedPeriods, seriesOf, yearMetric, type DeepTimeline,
} from "./timeline";
import { DEFS, availablePeriods, defById, resolveMetric } from "./metrics";
import { NULL_GRAY } from "./palette";
import { buildScale } from "./scale";
import { SAMPLE } from "./data";
import type { AnnualSeries, MapData, Metro, Period } from "../types";

// the built file is optional in ci, so the suites that read it skip without it
const BUILT_PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const BUILT: MapData | null = existsSync(BUILT_PATH) ? (JSON.parse(readFileSync(BUILT_PATH, "utf8")) as MapData) : null;

const abilene = SAMPLE.metros[0];
const sparse = SAMPLE.metros[2];
const def = (id: string) => defById(id)!.def;
const tick = (id: string, period: Period, metros = SAMPLE.metros) => buildTimeline(def(id), metros).ticks.find((t) => t.period === period)!;

describe("dates", () => {
  it("place a year at its start, a month at its start and a day within the month", () => {
    expect(dateToYear("2014")).toBe(2014);
    expect(dateToYear("2026-07")).toBe(2026.5);
    expect(dateToYear("2026-07-31")).toBeCloseTo(2026 + (6 + 30 / 31) / 12, 3);
    expect(dateToYear("2026-01-01")).toBe(2026);
  });

  it("reject anything that is not a date", () => {
    expect(dateToYear(null)).toBeNull();
    expect(dateToYear("")).toBeNull();
    expect(dateToYear("2026-13")).toBeNull();
    expect(dateToYear("2026Q2")).toBeNull();
  });

  it("label months in words and bare years as years, fiscal for hud", () => {
    expect(dateLabel("2026-07")).toBe("Jul 2026");
    expect(dateLabel("2026-07-31", "zillow")).toBe("Jul 2026");
    expect(dateLabel("2027", "hud")).toBe("FY 2027");
    expect(dateLabel("2025", "pep")).toBe("2025");
    expect(dateLabel("2023")).toBe("2023");
    expect(dateLabel(null)).toBeNull();
    expect(dateLabel("origin 2026Q2")).toBe("origin 2026Q2");
  });
});

describe("axis", () => {
  it("ends at the newest latest date in the data, never before 2025", () => {
    expect(newestYear(SAMPLE.metros)).toBeCloseTo(2026 + 7 / 12, 4);
    expect(axisEnd(SAMPLE.metros)).toBeCloseTo(2026 + 7 / 12, 4);
    expect(axisEnd([])).toBe(AXIS_MIN_END);
    expect(newestYear([{} as Metro])).toBeNull();
    const fiscal = [{ ...abilene, latest: { ...abilene.latest, fmr_2br: 1200, fmr_2br_date: "2027" } } as Metro];
    expect(axisEnd(fiscal)).toBe(2027);
  });

  it("marks every calendar year from 2014 to the end", () => {
    const model = buildTimeline(def("unemp"), SAMPLE.metros);
    expect(model.start).toBe(AXIS_START);
    expect(model.marks.map((m) => m.year)).toEqual([2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
    expect(model.marks[0].t).toBe(0);
    expect(model.marks[model.marks.length - 1].t).toBeLessThan(1);
  });
});

describe("latest dates and counts", () => {
  it("find the newest date a definition carries at latest", () => {
    expect(latestDate(def("median_listing_price"), SAMPLE.metros)).toBe("2026-08");
    expect(latestDate(def("unemp"), SAMPLE.metros)).toBe("2026-07");
    expect(latestDate(def("permits_per_1000"), SAMPLE.metros)).toBe("2025");
    expect(latestDate(def("hpi"), SAMPLE.metros)).toBe("2026-06");
    // income is still a vintage only measure, so it has no latest at all
    expect(latestDate(def("income"), SAMPLE.metros)).toBeNull();
    expect(latestDate(def("unemp"), [])).toBeNull();
  });

  it("count metros with a value at each declared period only", () => {
    expect(periodCounts(def("hpi"), SAMPLE.metros)).toEqual({ "2014": 3, "2019": 3, "2024": 2, latest: 1 });
    expect(periodCounts(def("income"), SAMPLE.metros)).toEqual({ "2014": 2, "2019": 3, "2024": 3, latest: 0 });
    expect(periodCounts(def("irs_net_returns"), SAMPLE.metros)).toEqual({ "2014": 2, "2019": 3, "2024": 0, latest: 3 });
    expect(periodCounts(def("hpi_forecast_4q"), SAMPLE.metros)).toEqual({ "2014": 0, "2019": 0, "2024": 0, latest: 2 });
    expect(periodCounts(def("hpi_19_24"), SAMPLE.metros)).toEqual({ "2014": 0, "2019": 0, "2024": 0, latest: 0 });
  });

  it("agree with availablePeriods for every definition", () => {
    for (const d of DEFS) {
      const model = buildTimeline(d, SAMPLE.metros);
      const available = model.ticks.filter((t) => t.available).map((t) => t.period);
      expect(available, d.id).toEqual(availablePeriods(d, SAMPLE.metros));
    }
  });

  it("list the published periods by id", () => {
    const published = publishedPeriods(SAMPLE.metros);
    expect(published.hpi).toEqual(["2014", "2019", "2024", "latest"]);
    expect(published.income).toEqual(["2014", "2019", "2024"]);
    expect(published.irs_net_returns).toEqual(["2014", "2019", "latest"]);
    expect(published.hpi_19_24).toEqual([]);
    expect(publishedPeriods([]).unemp).toEqual(["2014", "2019", "2024", "latest"]);
  });
});

describe("buildTimeline", () => {
  it("draws four ticks with the years filled and latest hollow for a vintage only measure", () => {
    const model = buildTimeline(def("income"), SAMPLE.metros);
    expect(model.ticks.map((t) => t.period)).toEqual(["2014", "2019", "2024", "latest"]);
    expect(model.ticks.map((t) => t.available)).toEqual([true, true, true, false]);
    expect(model.ticks.map((t) => t.label)).toEqual(["2014", "2019", "2024", "latest"]);
    expect(model.ticks[0].t).toBe(0);
    expect(model.ticks[1].t).toBeCloseTo(5 / (model.end - 2014), 3);
    expect(model.ticks[3].t).toBe(1);
    expect(model.ticks[3].date).toBeNull();
    expect(model.span).toBeNull();
  });

  it("puts a latest only measure on its true date with the years hollow", () => {
    const model = buildTimeline(def("hpi_forecast_4q"), SAMPLE.metros);
    expect(model.ticks.map((t) => t.available)).toEqual([false, false, false, true]);
    const latest = model.ticks[3];
    expect(latest.label).toBe("Jun 2026");
    expect(latest.date).toBe("2026-06");
    expect(latest.count).toBe(2);
    expect(latest.year).toBeCloseTo(2026 + 5 / 12, 4);
    expect(latest.t).toBeCloseTo((latest.year - 2014) / (model.end - 2014), 3);
    expect(latest.t).toBeLessThan(1);
  });

  it("leaves an undeclared latest at the end of the axis even when the panel carries a date", () => {
    const acs = buildTimeline(def("gross_rent"), SAMPLE.metros).ticks[3];
    expect(abilene.latest.gross_rent_date).toBe("2024");
    expect(acs).toMatchObject({ available: false, label: "latest", date: null, t: 1 });
  });

  it("labels a fiscal year latest and a bare year latest", () => {
    const hud = [{ ...abilene, latest: { ...abilene.latest, fmr_2br: 1200, fmr_2br_date: "2027" } } as Metro];
    expect(tick("fmr_2br", "latest", hud).label).toBe("FY 2027");
    expect(tick("pop_estimate", "latest").label).toBe("2025");
  });

  it("keeps the count under each tick", () => {
    expect(tick("irs_net_returns", "2014").count).toBe(2);
    expect(tick("irs_net_returns", "2024")).toMatchObject({ count: 0, available: false });
    expect(tick("irs_net_returns", "latest")).toMatchObject({ count: 3, available: true, label: "2023" });
  });

  it("pushes a latest that is the 2024 figure just past the 2024 tick", () => {
    const bea = [{ ...abilene, latest: { ...abilene.latest, bea_population: 185000, bea_population_date: "2024" } } as Metro];
    const model = buildTimeline(def("bea_population"), bea);
    const year = model.ticks[2];
    const latest = model.ticks[3];
    expect(latest.year).toBe(2024);
    expect(latest.t).toBeGreaterThan(year.t);
    expect((latest.t - year.t) * AXIS_WIDTH).toBeCloseTo(14, 1);
    expect(latest.row).not.toBe(year.row);
  });

  it("drops a crowded label to the second row and keeps spaced labels on the first", () => {
    const model = buildTimeline(def("unemp"), SAMPLE.metros);
    expect(model.ticks.slice(0, 3).map((t) => t.row)).toEqual([0, 0, 0]);
    expect(model.ticks[3].row).toBe(1);
    const wide = buildTimeline(def("unemp"), SAMPLE.metros, 2000);
    expect(wide.ticks.map((t) => t.row)).toEqual([0, 0, 0, 0]);
  });

  it("shades the span of a change figure and draws no ticks", () => {
    const model = buildTimeline(def("hpi_19_24"), SAMPLE.metros);
    expect(model.ticks).toEqual([]);
    expect(model.span).toMatchObject({ from: 2019, to: 2024 });
    expect(model.span!.t0).toBeCloseTo(5 / (model.end - 2014), 3);
    expect(model.span!.t1).toBeCloseTo(10 / (model.end - 2014), 3);
    expect(changeSpan(def("income_14_24"))).toEqual({ from: 2014, to: 2024 });
    expect(changeSpan(def("unemp"))).toBeNull();
  });

  it("treats declared periods as available before data loads", () => {
    const model = buildTimeline(def("median_listing_price"), []);
    expect(model.ticks.map((t) => t.available)).toEqual([false, true, true, true]);
    expect(model.ticks.map((t) => t.count)).toEqual([0, 0, 0, 0]);
    expect(model.end).toBe(AXIS_MIN_END);
  });
});

describe("stepping", () => {
  const available: Period[] = ["2014", "2019", "latest"];

  it("moves to the neighbouring available period and stops at the ends", () => {
    expect(nextPeriod("2014", available)).toBe("2019");
    expect(nextPeriod("2019", available)).toBe("latest");
    expect(nextPeriod("latest", available)).toBeNull();
    expect(prevPeriod("latest", available)).toBe("2019");
    expect(prevPeriod("2014", available)).toBeNull();
  });

  it("enters from either end when the current period is not available", () => {
    expect(nextPeriod("2024", available)).toBe("2014");
    expect(nextPeriod(null, available)).toBe("2014");
    expect(prevPeriod("2024", available)).toBe("latest");
    expect(nextPeriod("2014", [])).toBeNull();
    expect(prevPeriod(null, [])).toBeNull();
  });
});

describe("labels", () => {
  it("name the period a map value belongs to", () => {
    expect(periodLabel(resolveMetric(def("income"), "2024"), abilene)).toBe("2024");
    expect(periodLabel(resolveMetric(def("unemp"), "latest"), abilene)).toBe("Jul 2026");
    expect(periodLabel(resolveMetric(def("hpi_forecast_4q"), "latest"), abilene)).toBe("Jun 2026");
    expect(periodLabel(resolveMetric(def("unemp"), "latest"), sparse)).toBe("latest");
    expect(periodLabel(resolveMetric(def("hpi_19_24"), null), abilene)).toBe("2019 to 2024");
    expect(periodLabel(resolveMetric(def("permits_per_1000"), "latest"), abilene)).toBe("2025");
  });

  it("note the measures that start after the first vintage year", () => {
    const rows = [
      { label: "House price index", periods: ["2014", "2019", "2024"] as Period[] },
      { label: "Median listing price", periods: ["2019", "2024", "latest"] as Period[] },
      { label: "Active listings", periods: ["2019", "2024", "latest"] as Period[] },
      { label: "Late", periods: ["2024"] as Period[] },
      { label: "Nothing", periods: [] as Period[] },
    ];
    expect(laterStartsNote(rows)).toBe("From 2019: Median listing price, Active listings. From 2024: Late.");
    expect(laterStartsNote(rows.slice(0, 1))).toBeNull();
    expect(laterStartsNote([])).toBeNull();
  });

  // a blank 2014 for hud is the api's own floor, not a hole in this metro
  it("names why a late source is late, once, and only when it is late", () => {
    const hud = { label: "Median family income", periods: ["2019", "2024", "latest"] as Period[], source: "hud" as const };
    const rent = { label: "Fair market rent, two bedroom", periods: ["2019", "2024"] as Period[], source: "hud" as const };
    expect(laterStartsNote([hud, rent])).toBe(
      "From 2019: Median family income, Fair market rent, two bedroom. "
      + "HUD publishes no fair market rents or income limits before fiscal 2017.",
    );
    const early = { label: "House price index", periods: ["2014", "2019"] as Period[], source: "fhfa" as const };
    expect(laterStartsNote([early])).toBeNull();
    expect(laterStartsNote([{ ...hud, source: "zillow" as const }])).toBe("From 2019: Median family income.");
  });
});

describe("latestColumn", () => {
  it("dates the header when the rows agree and each cell when they do not", () => {
    const agree = latestColumn(abilene, [def("permits_units"), def("permits_single_family"), def("vacancy_rate")]);
    expect(agree).toEqual({ show: true, header: "2025", dates: { permits_units: "2025", permits_single_family: "2025" } });
    const differ = latestColumn(abilene, [def("hpi"), def("zhvi"), def("median_listing_price")]);
    expect(differ.show).toBe(true);
    expect(differ.header).toBeNull();
    expect(differ.dates).toEqual({ hpi: "Jun 2026", zhvi: "Jul 2026", median_listing_price: "Aug 2026" });
  });

  it("stays hidden when no row has a latest value for the metro", () => {
    expect(latestColumn(abilene, [def("income"), def("pop")])).toEqual({ show: false, header: null, dates: {} });
    expect(latestColumn(sparse, [def("zhvi")]).show).toBe(false);
    // the division inherits its permits, so the derived rate has no latest value
    expect(latestColumn(sparse, [def("permits_per_1000")])).toEqual({ show: false, header: null, dates: {} });
  });
});

// ---- the deep annual run ----

const hpi = def("hpi");
const asOf = "2026Q2";

// a metro carrying one annual history. everything else is abilene's, since
// none of it is read here
const withSeries = (cbsa: string, start: number, values: (number | null)[], extra: Partial<AnnualSeries> = {}): Metro =>
  ({ ...abilene, cbsa, series: { hpi: { start, values, as_of: asOf, ...extra } } }) as Metro;

const years = (deep: DeepTimeline) => deep.frames.map((f) => f.year);

describe("reading an annual history", () => {
  it("takes the level of a year inside the run and nothing outside it", () => {
    const s: AnnualSeries = { start: 2000, values: [100, null, 121], as_of: asOf };
    expect(levelAt(s, 2000)).toBe(100);
    expect(levelAt(s, 2001)).toBeNull();
    expect(levelAt(s, 2002)).toBe(121);
    expect(levelAt(s, 1999)).toBeNull();
    expect(levelAt(s, 2003)).toBeNull();
    expect(levelAt(null, 2000)).toBeNull();
  });

  it("measures the change into a year and refuses a year with no year before it", () => {
    const s: AnnualSeries = { start: 2000, values: [100, 110, null, 121], as_of: asOf };
    expect(growthAt(s, 2001)).toBeCloseTo(10, 10);
    // the first year of a metro has nothing to be measured against
    expect(growthAt(s, 2000)).toBeNull();
    expect(growthAt(s, 2002)).toBeNull();
    expect(growthAt(s, 2003)).toBeNull();
    expect(growthAt(s, 2004)).toBeNull();
  });

  it("treats a zero or negative level as no measurement rather than as infinity", () => {
    expect(growthAt({ start: 2000, values: [0, 110], as_of: asOf }, 2001)).toBeNull();
    expect(growthAt({ start: 2000, values: [-5, 110], as_of: asOf }, 2001)).toBeNull();
  });

  it("finds a history on a metro and refuses a shape that is not one", () => {
    expect(seriesOf(SAMPLE.metros[0], "hpi")?.start).toBe(2014);
    expect(seriesOf(SAMPLE.metros[1], "hpi")).toBeNull();
    expect(seriesOf({} as Metro, "hpi")).toBeNull();
    expect(seriesOf({ ...abilene, series: { hpi: { start: 2000 } } } as unknown as Metro, "hpi")).toBeNull();
    expect(seriesOf({ ...abilene, series: { hpi: { start: "x", values: [1] } } } as unknown as Metro, "hpi")).toBeNull();
  });
});

describe("buildDeepTimeline", () => {
  it("runs one frame a year from the first year that carries a change to the last", () => {
    const deep = buildDeepTimeline(hpi, SAMPLE.metros)!;
    expect(deep.key).toBe("hpi");
    // the history starts in 2014, and 2014 has no year before it to measure from
    expect(years(deep)).toEqual([2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
    expect(deep.frames[0].t).toBe(0);
    expect(deep.frames[deep.frames.length - 1].t).toBe(1);
    expect(deep.frames[6].t).toBeCloseTo(6 / 11, 4);
    expect(deep.asOf).toBe(asOf);
  });

  it("counts the metros that have a change that year against every metro in the build", () => {
    const deep = buildDeepTimeline(hpi, SAMPLE.metros)!;
    // one of the three sample metros carries a history, and all three are on the map
    expect(deep.total).toBe(3);
    expect(deep.frames.map((f) => f.count)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("gives back nothing for a definition no annual history stands behind", () => {
    expect(buildDeepTimeline(def("income"), SAMPLE.metros)).toBeNull();
    expect(buildDeepTimeline(def("unemp"), SAMPLE.metros)).toBeNull();
    expect(buildDeepTimeline(def("hpi_19_24"), SAMPLE.metros)).toBeNull();
    expect(DEEP_DEFS.hpi).toBe("hpi");
  });

  it("gives back nothing for an empty metro list, so the four panels stand", () => {
    expect(buildDeepTimeline(hpi, [])).toBeNull();
  });

  it("gives back nothing when every value in the only history is missing", () => {
    const blank = withSeries("00001", 1990, [null, null, null, null]);
    expect(buildDeepTimeline(hpi, [blank])).toBeNull();
  });

  it("gives back nothing when the only history is a single year, which no change spans", () => {
    expect(buildDeepTimeline(hpi, [withSeries("00001", 1990, [100])])).toBeNull();
  });

  it("keeps a lone metro, whose run is one frame wide when its history is two years", () => {
    const deep = buildDeepTimeline(hpi, [withSeries("00001", 1990, [100, 110])])!;
    expect(years(deep)).toEqual([1991]);
    expect(deep.frames[0]).toMatchObject({ t: 0, count: 1 });
    expect(deep.total).toBe(1);
  });

  it("starts where the earliest metro starts and ends where the latest one ends", () => {
    const deep = buildDeepTimeline(hpi, [
      withSeries("00001", 1975, [100, 105, 110]),
      withSeries("00002", 1990, [100, 104]),
    ])!;
    expect(years(deep)).toEqual([1976, 1977, ...Array.from({ length: 14 }, (_, i) => 1978 + i)]);
    expect(deep.frames[0]).toMatchObject({ year: 1976, count: 1 });
    // 1978 to 1990 is inside the run and nobody reports it
    expect(deep.frames.find((f) => f.year === 1985)).toMatchObject({ count: 0 });
    expect(deep.frames[deep.frames.length - 1]).toMatchObject({ year: 1991, count: 1 });
    expect(deep.total).toBe(2);
  });

  it("counts a metro out of the years its history skips without ending the run there", () => {
    const deep = buildDeepTimeline(hpi, [
      withSeries("00001", 1990, [100, 105, null, 120, 126]),
      withSeries("00002", 1990, [100, 105, 110, 120, 126]),
    ])!;
    expect(years(deep)).toEqual([1991, 1992, 1993, 1994]);
    // a gap costs the year it falls in and the year after, which has nothing to measure from
    expect(deep.frames.map((f) => f.count)).toEqual([2, 1, 1, 2]);
  });

  it("marks the final year partial when a history says it stops at its as of quarter", () => {
    const deep = buildDeepTimeline(hpi, [
      withSeries("00001", 1990, [100, 105, 110], { partial_year: 1992 }),
      withSeries("00002", 1990, [100, 104, 108], { partial_year: 1992 }),
    ])!;
    expect(deep.frames.map((f) => f.partial)).toEqual([false, true]);
    expect(frameName(deep.frames[1])).toBe("1992 so far");
    expect(frameName(deep.frames[0])).toBe("1991");
  });

  it("names no as of quarter when the histories do not agree on one", () => {
    const deep = buildDeepTimeline(hpi, [
      withSeries("00001", 1990, [100, 105], { as_of: "2026Q2" }),
      withSeries("00002", 1990, [100, 104], { as_of: "2026Q1" }),
    ])!;
    expect(deep.asOf).toBeNull();
  });
});

describe("the colour cap", () => {
  // a scale rebuilt per year would recolour the map under the reader, and a
  // scale stretched to the single worst year would wash out every other one
  it("is a round number near the far end of the changes the run carries", () => {
    const deep = buildDeepTimeline(hpi, SAMPLE.metros)!;
    expect(deep.cap).toBe(5);
  });

  it("clips the extremes rather than letting them own the ramp", () => {
    // ninety nine calm years and one crash: the crash does not set the scale
    const values = [100, ...Array.from({ length: 99 }, (_, i) => 100 * 1.03 ** (i + 1))];
    values.push(values[values.length - 1] * 0.55);
    const deep = buildDeepTimeline(hpi, [withSeries("00001", 1900, values)])!;
    expect(deep.cap).toBe(5);
  });

  it("never falls below a readable width, whatever the data does", () => {
    const flat = buildDeepTimeline(hpi, [withSeries("00001", 1990, [100, 100, 100])])!;
    expect(flat.cap).toBe(5);
  });

  it("gives the map five symmetric classes around no change", () => {
    const deep = buildDeepTimeline(hpi, SAMPLE.metros)!;
    const scale = buildScale([-deep.cap, deep.cap], "diverging");
    expect(scale.domain).toEqual([-5, 5]);
    expect(scale.bins.map((b) => [b.from, b.to])).toEqual([[-5, -3], [-3, -1], [-1, 1], [1, 3], [3, 5]]);
    // anything past the ends lands in the end class rather than going uncoloured
    expect(scale.color(-40)).toBe(scale.bins[0].color);
    expect(scale.color(40)).toBe(scale.bins[4].color);
    expect(scale.color(null)).toBe(NULL_GRAY);
  });
});

describe("moving through the run", () => {
  const deep = buildDeepTimeline(hpi, SAMPLE.metros)!;

  it("finds the frame a year names", () => {
    expect(frameIndex(deep, 2015)).toBe(0);
    expect(frameIndex(deep, 2020)).toBe(5);
    expect(frameAt(deep, 2020).year).toBe(2020);
  });

  it("opens on the newest year when no year has been chosen", () => {
    expect(frameIndex(deep, null)).toBe(deep.frames.length - 1);
    expect(frameAt(deep, null).year).toBe(2026);
  });

  it("clamps a year from before the run and a year from after it", () => {
    expect(frameAt(deep, 1800).year).toBe(2015);
    expect(frameAt(deep, 1900).year).toBe(2015);
    expect(frameAt(deep, 2100).year).toBe(2026);
    expect(frameAt(deep, NaN).year).toBe(2026);
  });

  it("steps to the next frame and stops rather than looping at the end", () => {
    expect(nextFrame(0, 12)).toBe(1);
    expect(nextFrame(10, 12)).toBe(11);
    expect(nextFrame(11, 12)).toBe(-1);
    expect(nextFrame(0, 1)).toBe(-1);
    expect(nextFrame(-1, 12)).toBe(-1);
  });

  it("reads a frame out with the coverage behind it, so a blank map is explained", () => {
    expect(frameText(deep.frames[0], deep.total)).toBe("2015, 1 of 3 metros");
    const partial = { year: 2026, t: 1, count: 410, partial: true };
    expect(frameText(partial, 410)).toBe("2026 so far, 410 of 410 metros");
  });
});

describe("a metric read at one year of its history", () => {
  const deep = buildDeepTimeline(hpi, SAMPLE.metros)!;

  it("colours by the change into the year, not by the level", () => {
    const metric = yearMetric(hpi, deep, 2021);
    // the index is rebased to 100 at each metro's own first quarter, so a
    // level of 259 in one metro and 259 in another are not the same thing
    expect(metric.accessor(abilene)).toBeCloseTo(9.8263, 3);
    expect(metric.format).toBe("rate");
    expect(metric.kind).toBe("diverging");
    expect(metric.source).toBe("fhfa");
    expect(metric.def).toBe(hpi);
    expect(metric.period).toBeNull();
    expect(metric.year).toBe(2021);
  });

  it("leaves a metro with no history that year uncoloured rather than at zero", () => {
    const metric = yearMetric(hpi, deep, 2021);
    expect(metric.accessor(SAMPLE.metros[1])).toBeNull();
    expect(metric.accessor(sparse)).toBeNull();
    expect(yearMetric(hpi, deep, 2015).accessor(abilene)).toBeCloseTo(3.7988, 3);
  });

  it("names both years it spans, and says when the last one is not whole", () => {
    expect(yearMetric(hpi, deep, 2021).label).toBe("House price index growth, 2020 to 2021");
    expect(yearMetric(hpi, deep, 2021).id).toBe("hpi_y2021");
    const partial = buildDeepTimeline(hpi, [withSeries("00001", 1990, [100, 105, 110], { partial_year: 1992 })])!;
    expect(yearMetric(hpi, partial, 1992).label).toBe("House price index growth, 1991 to 1992 so far");
  });

  it("clamps a year outside the run instead of drawing a year that is not there", () => {
    expect(yearMetric(hpi, deep, 1800).year).toBe(2015);
    expect(yearMetric(hpi, deep, null).year).toBe(2026);
    expect(yearMetric(hpi, deep, 1800).accessor(abilene)).toBeCloseTo(3.7988, 3);
  });

  it("is told apart from a metric read at one of the four panels", () => {
    expect(isYearMetric(yearMetric(hpi, deep, 2021))).toBe(true);
    expect(isYearMetric(resolveMetric(hpi, "2024"))).toBe(false);
    expect(isYearMetric(resolveMetric(def("hpi_19_24"), null))).toBe(false);
  });

  it("names its own year on the map, where a panel would name its period", () => {
    expect(periodLabel(yearMetric(hpi, deep, 2021), abilene)).toBe("2021");
    const partial = buildDeepTimeline(hpi, [withSeries("00001", 1990, [100, 105, 110], { partial_year: 1992 })])!;
    expect(periodLabel(yearMetric(hpi, partial, 1992), abilene)).toBe("1992 so far");
    // the four panel metrics still name their period exactly as they did
    expect(periodLabel(resolveMetric(hpi, "2024"), abilene)).toBe("2024");
  });

  it("captions the legend with the two years and says the colours do not move", () => {
    expect(deepCaption(hpi, deep, 2021)).toBe("Source: FHFA, 2020 to 2021. One colour scale for every year.");
    const partial = buildDeepTimeline(hpi, [withSeries("00001", 1990, [100, 105, 110], { partial_year: 1992 })])!;
    expect(deepCaption(hpi, partial, 1992)).toBe("Source: FHFA, 1991 to 2026Q2. One colour scale for every year.");
  });
});

describe.skipIf(!BUILT)("the built annual histories", () => {
  const metros = BUILT!.metros;

  it("carry a run that reaches back before 2000 for all but a handful of metros", () => {
    const early = metros.filter((m) => (seriesOf(m, "hpi")?.start ?? 9999) < 2000);
    expect(metros.length).toBeGreaterThan(400);
    expect(early.length).toBeGreaterThan(metros.length - 5);
  });

  it("build one frame a year over fifty years, ending on a part year", () => {
    const deep = buildDeepTimeline(hpi, metros)!;
    expect(deep.frames.length).toBeGreaterThan(45);
    expect(deep.frames[0].year).toBeLessThan(1980);
    expect(deep.total).toBe(metros.length);
    expect(deep.frames[deep.frames.length - 1].partial).toBe(true);
    expect(deep.asOf).toMatch(/^\d{4}Q[1-4]$/);
    expect(deep.cap).toBe(10);
  });

  it("start thin and fill in, which is why the count is drawn beside the year", () => {
    const deep = buildDeepTimeline(hpi, metros)!;
    expect(deep.frames[0].count).toBeLessThan(metros.length / 4);
    expect(deep.frames[deep.frames.length - 1].count).toBe(metros.length);
    const rising = deep.frames.filter((f, i) => i > 0 && f.count >= deep.frames[i - 1].count - 1);
    expect(rising.length).toBe(deep.frames.length - 1);
  });

  // this is the thing the run exists to show
  it("colour the crash blue and the boom red on one scale that never moves", () => {
    const deep = buildDeepTimeline(hpi, metros)!;
    const scale = buildScale([-deep.cap, deep.cap], "diverging");
    const median = (year: number) => {
      const values = metros.map((m) => growthAt(seriesOf(m, "hpi"), year)).filter((v): v is number => v !== null);
      values.sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    };
    expect(median(2009)).toBeLessThan(0);
    expect(median(2010)).toBeLessThan(0);
    expect(median(2021)).toBeGreaterThan(10);
    expect(scale.color(median(2010))).toBe(scale.bins[1].color);
    expect(scale.color(median(2021))).toBe(scale.bins[4].color);
    expect(scale.color(median(2016))).toBe(scale.bins[3].color);
  });

  it("colour every frame without leaving the middle class holding the whole country", () => {
    const deep = buildDeepTimeline(hpi, metros)!;
    const scale = buildScale([-deep.cap, deep.cap], "diverging");
    for (const frame of deep.frames) {
      const metric = yearMetric(hpi, deep, frame.year);
      const drawn = metros.map(metric.accessor).filter((v): v is number => v !== null);
      expect(drawn.length, String(frame.year)).toBe(frame.count);
      if (drawn.length < 20) continue;
      // the wash out test: no year may hand the whole country one colour
      const middle = drawn.filter((v) => scale.color(v) === scale.bins[2].color).length;
      expect(middle / drawn.length, String(frame.year)).toBeLessThan(0.8);
    }
  });
});

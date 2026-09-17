import { describe, expect, it } from "vitest";
import {
  AXIS_MIN_END, AXIS_START, AXIS_WIDTH, axisEnd, buildTimeline, changeSpan, dateLabel, dateToYear, laterStartsNote,
  latestColumn, latestDate, newestYear, nextPeriod, periodCounts, periodLabel, prevPeriod, publishedPeriods,
} from "./timeline";
import { DEFS, availablePeriods, defById, resolveMetric } from "./metrics";
import { SAMPLE } from "./data";
import type { Metro, Period } from "../types";

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

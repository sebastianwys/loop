import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFS, GROUPS, METRICS, PERIODS, availablePeriods, canBeWithheld, defById, defaultPeriod, labelFor, metricById,
  metricCaption, metricExplainer, nearestPeriod, num, resolveMetric, visibleDefs, withheldReason, withheldWhy, yearLabel,
} from "./metrics";
import { formatValue } from "./format";
import { dateLabel } from "./timeline";
import type { MapData, Metro, Period } from "../types";
import { SAMPLE } from "./data";

const abilene = SAMPLE.metros[0];
const dallas = SAMPLE.metros[1];
const sparse = SAMPLE.metros[2];
const def = (id: string) => defById(id)!.def;

describe("metric accessors", () => {
  it("return numbers for a complete metro", () => {
    expect(metricById("hpi_19_24").accessor(abilene)).toBeCloseTo(0.3291);
    expect(metricById("ptir_2024").accessor(abilene)).toBeCloseTo(2.67);
    expect(metricById("income_2024").accessor(abilene)).toBe(62010);
  });

  it("return null where the field is null", () => {
    expect(metricById("hpi_19_24").accessor(sparse)).toBeNull();
    expect(metricById("zhvi_latest").accessor(sparse)).toBeNull();
    expect(metricById("ptir_2024").accessor(sparse)).toBeNull();
  });

  it("never throw on an empty object at any period", () => {
    const empty = {} as Metro;
    for (const d of DEFS) {
      for (const p of [...PERIODS, null] as (Period | null)[]) {
        expect(() => d.valueAt(empty, p), `${d.id} at ${p}`).not.toThrow();
        expect(d.valueAt(empty, p), `${d.id} at ${p}`).toBeNull();
      }
    }
    for (const metric of METRICS) {
      expect(metric.accessor(empty)).toBeNull();
    }
  });

  it("treat nan and strings as missing", () => {
    expect(num(Number.NaN)).toBeNull();
    expect(num("12")).toBeNull();
    expect(num(12)).toBe(12);
  });

  it("fall back to the first metric for an unknown id", () => {
    expect(metricById("nope").id).toBe(METRICS[0].id);
  });

  it("read enrichment fields from year panels and from latest", () => {
    expect(def("gross_rent").valueAt(abilene, "2024")).toBe(1141);
    expect(def("permits_units").valueAt(abilene, "latest")).toBe(1160);
    expect(def("irs_net_returns").valueAt(abilene, "2024")).toBeNull();
  });
});

describe("periods", () => {
  it("resolve a legacy id into a definition and a period", () => {
    expect(defById("income_2024")).toMatchObject({ period: "2024" });
    expect(defById("zhvi_latest")).toMatchObject({ period: "latest" });
    expect(defById("hpi_19_24")).toMatchObject({ period: null });
    expect(defById("nothing_2024")).toBeNull();
  });

  it("label the resolved metric with its period, change metrics without", () => {
    expect(resolveMetric(def("gross_rent"), "2019").label).toBe("Median gross rent, 2019");
    expect(resolveMetric(def("permits_units"), "latest").label).toBe("Housing units permitted, latest");
    const change = resolveMetric(def("hpi_19_24"), "2024");
    expect(change.period).toBeNull();
    expect(change.id).toBe("hpi_19_24");
  });

  it("fall back to the default period when the asked one is not declared", () => {
    expect(resolveMetric(def("gross_rent"), "latest").period).toBe("2024");
    expect(resolveMetric(def("zhvf_forecast"), "2014").period).toBe("latest");
  });

  it("report only the declared periods that carry data", () => {
    expect(availablePeriods(def("irs_net_returns"), SAMPLE.metros)).toEqual(["2014", "2019", "latest"]);
    expect(availablePeriods(def("days_to_pending"), [dallas])).toEqual([]);
    expect(availablePeriods(def("gross_rent"), [])).toEqual(["2014", "2019", "2024"]);
  });

  it("pick the nearest available period, later on a tie", () => {
    expect(nearestPeriod("2024", ["2014", "2019", "latest"])).toBe("latest");
    expect(nearestPeriod("2014", ["2019", "2024"])).toBe("2019");
    expect(nearestPeriod("2019", ["2019", "2024"])).toBe("2019");
    expect(nearestPeriod(null, ["2014", "2019"])).toBe("2019");
    expect(nearestPeriod("latest", [])).toBeNull();
  });
});

describe("visibility", () => {
  it("hides a metric that is null for every metro and keeps one with a single value", () => {
    const ids = visibleDefs(SAMPLE.metros).map((d) => d.id);
    expect(ids).not.toContain("bea_income_per_capita");
    expect(ids).not.toContain("fmr_2br");
    expect(ids).toContain("gross_rent");
    expect(ids).toContain("hpi_19_24");
    const one = [{ ...sparse, latest: { ...sparse.latest, fmr_2br: 1200 } } as Metro];
    expect(visibleDefs(one).map((d) => d.id)).toContain("fmr_2br");
  });

  it("shows everything before data loads", () => {
    expect(visibleDefs([])).toHaveLength(DEFS.length);
  });
});

describe("derived metrics", () => {
  it("compute permits per thousand and rent to income", () => {
    expect(def("permits_per_1000").valueAt(abilene, "2024")).toBeCloseTo((527 / 183719) * 1000, 4);
    expect(def("rent_to_income").valueAt(abilene, "2024")).toBeCloseTo((1141 * 12) / 62010, 4);
  });

  it("return null when an input is missing or the population is zero", () => {
    const zero = { ...abilene, years: { ...abilene.years, "2024": { ...abilene.years["2024"], pop_estimate: 0 } } } as Metro;
    expect(def("permits_per_1000").valueAt(zero, "2024")).toBeNull();
    // the sparse division inherits permits_units, so its own population cannot rate it
    expect(def("permits_per_1000").valueAt(sparse, "2014")).toBeNull();
    expect(def("rent_to_income").valueAt(sparse, "2014")).toBeNull();
    expect(def("rent_to_income").valueAt(abilene, "latest")).toBeNull();
  });
});

describe("captions and labels", () => {
  it("name the source and the newest latest date across metros", () => {
    expect(metricCaption(resolveMetric(def("median_listing_price"), "latest"), SAMPLE.metros)).toBe("Source: Realtor.com, latest 2026-08");
    expect(metricCaption(resolveMetric(def("gross_rent"), "2019"), SAMPLE.metros)).toBe("Source: Census ACS, 2019");
    expect(metricCaption(resolveMetric(def("hpi_19_24"), null), SAMPLE.metros)).toBe("Source: FHFA");
    expect(metricCaption(resolveMetric(def("zhvf_forecast"), "latest"), [])).toBe("Source: Zillow, latest");
  });

  // hud counts by fiscal year, and the legend called a hud value 2027 while
  // the detail panel beside it called the same value FY 2027
  it("label a bare year the way its publisher counts years", () => {
    const metros = [{ ...SAMPLE.metros[0], latest: { ...SAMPLE.metros[0].latest, fmr_2br: 1200, fmr_2br_date: "2027" } }] as Metro[];
    expect(metricCaption(resolveMetric(def("fmr_2br"), "latest"), metros)).toBe("Source: HUD, latest FY 2027");
    expect(dateLabel("2027", "hud")).toBe("FY 2027");
    // and a month is a month, whoever published it
    expect(yearLabel(2027, "hud")).toBe("FY 2027");
    expect(yearLabel(2027, "zillow")).toBe("2027");
    expect(yearLabel(2027)).toBe("2027");
  });

  // the 2024 panel holds hud's fiscal 2024 file, so the caption says so the way
  // latest already did, and a calendar source keeps its bare year
  it("label a hud year panel as the fiscal year it is", () => {
    expect(metricCaption(resolveMetric(def("fmr_2br"), "2024"), SAMPLE.metros)).toBe("Source: HUD, FY 2024");
    expect(metricCaption(resolveMetric(def("gross_rent"), "2024"), SAMPLE.metros)).toBe("Source: Census ACS, 2024");
  });

  // fhfa sets the error in hundredths. at one decimal denver's 0.0496 read 0.0%
  // and phoenix's 0.31 and denver's 0.34 both read 0.3%
  it("print the index standard error in the hundredths fhfa sets it in", () => {
    const shown = (v: number) => formatValue(v, def("hpi_index_error").format);
    expect(shown(0.0496)).toBe("0.05%");
    expect(shown(0.31)).toBe("0.31%");
    expect(shown(0.34)).toBe("0.34%");
    expect(shown(10.56)).toBe("10.56%");
  });

  it("map a field key to its label and pass unknown keys through", () => {
    expect(labelFor("permits_units")).toBe("Housing units permitted");
    expect(labelFor("mystery")).toBe("mystery");
  });
});

// the headline index reads the newest fhfa quarter. the vintage averages stay
// in the year panels, and they are a different number
describe("house price index at latest", () => {
  it("offers a latest period and reads the newest quarter", () => {
    expect(def("hpi").periods).toContain("latest");
    const latest = def("hpi").valueAt(abilene, "latest");
    const vintage = def("hpi").valueAt(abilene, "2024");
    expect(latest).not.toBeNull();
    expect(latest).not.toBe(vintage);
    expect(resolveMetric(def("hpi"), "latest").dateOf(abilene)).toMatch(/^\d{4}-\d{2}$/);
  });

  it("keeps the vintage years reachable", () => {
    for (const y of ["2014", "2019", "2024"] as Period[]) {
      expect(def("hpi").valueAt(abilene, y)).not.toBeNull();
    }
  });
});

describe("forecasts", () => {
  const ids = ["hpi_forecast_4q", "hpi_forecast_8q", "hpi_trend_5y", "hpi_yoy_latest", "hpi_surprise_4q"];
  // realized growth over four quarters and five years is what the fhfa index
  // did up to the origin. the export works it out, but none of it is the
  // model's, so it is credited to fhfa like the rest of the index
  const realized = ["hpi_trend_5y", "hpi_yoy_latest"];
  // the index error sits in the group because it qualifies the forecast above
  // it, but it is fhfa's published number and not the model's, so it is
  // credited to fhfa and is not one of the diverging model values
  const alongside = "hpi_index_error";

  it("form the last group, read at latest only, with the model credited only for its own numbers", () => {
    expect(GROUPS[GROUPS.length - 1]).toBe("Forecasts");
    expect(DEFS.filter((d) => d.group === "Forecasts").map((d) => d.id)).toEqual([...ids, alongside]);
    expect(def(alongside).source).toBe("fhfa");
    expect(def(alongside).kind).toBe("sequential");
    expect(def(alongside).periods).toEqual(["latest"]);
    for (const id of ids) {
      expect(def(id).source, id).toBe(realized.includes(id) ? "fhfa" : "forecast");
      expect(def(id).periods).toEqual(["latest"]);
      expect(def(id).kind).toBe("diverging");
      expect(defaultPeriod(def(id))).toBe("latest");
      expect(resolveMetric(def(id), "2019").period).toBe("latest");
      expect(resolveMetric(def(id), null).id).toBe(`${id}_latest`);
    }
    expect(labelFor("hpi_forecast_4q")).toBe("Expected HPI growth, next 4 quarters");
    expect(labelFor("hpi_forecast_8q")).toBe("Expected HPI growth, next 8 quarters");
    expect(labelFor("hpi_trend_5y")).toBe("HPI growth, 5 year annualized");
    expect(labelFor("hpi_yoy_latest")).toBe("HPI growth, last 4 quarters");
    expect(labelFor("hpi_surprise_4q")).toBe("Surprise, actual minus expected, last 4 quarters");
  });

  it("appear in the menu only when the data carries them", () => {
    expect(visibleDefs(SAMPLE.metros).filter((d) => d.group === "Forecasts").map((d) => d.id)).toEqual(ids);
    expect(visibleDefs([sparse]).some((d) => d.group === "Forecasts")).toBe(false);
    expect(availablePeriods(def("hpi_forecast_4q"), SAMPLE.metros)).toEqual(["latest"]);
    expect(availablePeriods(def("hpi_forecast_4q"), [sparse])).toEqual([]);
  });

  it("read percent values from latest and never from a year panel", () => {
    expect(def("hpi_forecast_4q").valueAt(abilene, "latest")).toBe(3.1);
    expect(def("hpi_surprise_4q").valueAt(dallas, "latest")).toBe(-3.2);
    expect(def("hpi_trend_5y").valueAt(sparse, "latest")).toBeNull();
    expect(def("hpi_forecast_4q").valueAt(abilene, "2024")).toBeNull();
    expect(metricById("hpi_forecast_8q_latest").accessor(dallas)).toBe(1.5);
  });

  it("caption the model with the origin month", () => {
    expect(metricCaption(resolveMetric(def("hpi_forecast_4q"), "latest"), SAMPLE.metros)).toBe("Source: Loop model, latest 2026-06");
    expect(metricCaption(resolveMetric(def("hpi_surprise_4q"), "latest"), [sparse])).toBe("Source: Loop model, latest");
    expect(resolveMetric(def("hpi_forecast_4q"), "latest").dateOf(abilene)).toBe("2026-06");
  });

  it("caption and explain realized growth as fhfa's, not the model's", () => {
    for (const id of realized) {
      expect(metricCaption(resolveMetric(def(id), "latest"), SAMPLE.metros), id).toBe("Source: FHFA, latest 2026-06");
      expect(metricExplainer(resolveMetric(def(id), "latest")), id).not.toContain("Loop model");
    }
  });
});

// added to web/src/lib/metrics.test.ts (plus two import-line edits:
//   `import { existsSync, readFileSync } from "node:fs";` at the top and
//   `import type { MapData, Metro, Period } from "../types";`)

// a ratio has to read its numerator and its denominator off the same geography.
// a division that takes permits_units from its parent metro but keeps its own
// pop_estimate has no honest rate to report
describe("permits per 1,000 residents", () => {
  const inherits = (m: Metro, key: string) => (m.parent_metrics ?? []).includes(key);
  const mixed = (m: Metro) => inherits(m, "permits_units") && !inherits(m, "pop_estimate");
  const rate = (m: Metro, p: Period) => def("permits_per_1000").valueAt(m, p);

  it("is null for a division whose permits are inherited but whose population is its own", () => {
    // the sample division carries the parent's permits with its own 80,000 residents
    expect(mixed(sparse)).toBe(true);
    for (const p of PERIODS) expect(rate(sparse, p), `sample division at ${p}`).toBeNull();
  });

  it("never mixes geographies in the built metros.json", () => {
    const path = new URL("../../public/data/metros.json", import.meta.url).pathname;
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf8")) as MapData;

    // san rafael divides the san francisco msa's 7,750 permits by its own
    // 253,694 residents and reports 30.5 per 1k against a parent rate near 1.7
    const sanRafael = data.metros.find((m) => m.cbsa === "42034")!;
    expect(mixed(sanRafael)).toBe(true);
    expect(rate(sanRafael, "latest")).toBeNull();

    // marietta does the same and lands 4th of 410 on the ranking
    const marietta = data.metros.find((m) => m.cbsa === "31924")!;
    expect(mixed(marietta)).toBe(true);
    expect(rate(marietta, "latest")).toBeNull();

    const offenders = data.metros
      .filter((m) => mixed(m) && PERIODS.some((p) => rate(m, p) !== null))
      .map((m) => `${m.cbsa} ${m.name} ${rate(m, "latest")}`);
    expect(offenders).toEqual([]);
  });
});

// a panel whose permits and people were counted over different counties has
// no honest rate either, and the build marks it rather than dividing
describe("a permit rate over two different county sets", () => {
  const withMark = (period: "2014" | "latest", mark: number): Metro => {
    const years = { ...abilene.years, "2014": { ...abilene.years["2014"], permits_units: 205, pop_estimate: 179358 } };
    const latest = { ...abilene.latest, permits_units: 400, pop_estimate: 180000 };
    return period === "2014"
      ? { ...abilene, years: { ...years, "2014": { ...years["2014"], permits_footprint: mark } }, latest }
      : { ...abilene, years, latest: { ...latest, permits_footprint: mark } };
  };
  const rate = (m: Metro, p: Period) => def("permits_per_1000").valueAt(m, p);

  it("is null at the panel that carries the mark and nowhere else", () => {
    const marked = withMark("2014", 0.27);
    expect(rate(marked, "2014")).toBeNull();
    expect(rate(marked, "latest")).toBeCloseTo((400 * 1000) / 180000, 6);
    expect(rate(withMark("latest", 0.05), "latest")).toBeNull();
  });

  // a year whose two county sets nobody could weigh is withheld the same way
  it("is null and withheld where the build could not weigh the two county sets", () => {
    const years = { ...abilene.years, "2019": { ...abilene.years["2019"], permits_units: 300, pop_estimate: 170000, permits_unweighed: true } };
    const unweighed: Metro = { ...abilene, years };
    expect(rate(unweighed, "2019")).toBeNull();
    expect(withheldWhy(unweighed, def("permits_per_1000"), "2019")).toBe("permits");
    const weighed: Metro = { ...abilene, years: { ...years, "2019": { ...years["2019"], permits_unweighed: false } } };
    expect(rate(weighed, "2019")).toBeCloseTo((300 * 1000) / 170000, 6);
  });

  it("is withheld there, not missing, and says why", () => {
    const marked = withMark("2014", 0.27);
    expect(withheldWhy(marked, def("permits_per_1000"), "2014")).toBe("permits");
    expect(withheldWhy(marked, def("permits_per_1000"), "latest")).toBeNull();
    expect(withheldWhy(marked, metricById("permits_per_1000_2014"))).toBe("permits");
    expect(withheldReason("permits")).toContain("different counties");
  });
});

// a withheld number and a number nobody measured are different claims
describe("a decade rate withheld because the county lines moved", () => {
  const blank = { ...abilene.growth, income_14_24: null, pop_14_24: null, home_value_14_24: null };
  const refused: Metro = { ...abilene, growth: blank, footprint_refused: 0.047 };
  const unweighed: Metro = { ...abilene, growth: blank, footprint_unweighed: true };
  const unmarked: Metro = { ...abilene, growth: blank };

  it("is withheld when the build had both vintages and refused to divide them", () => {
    for (const id of ["income_14_24", "pop_14_24", "home_value_14_24"]) {
      expect(withheldWhy(refused, def(id)), id).toBe("footprint");
      expect(withheldWhy(unweighed, def(id)), id).toBe("footprint");
      expect(withheldWhy(unmarked, def(id)), id).toBeNull();
    }
  });

  it("is not withheld when a vintage is missing, since there was nothing to withhold", () => {
    const short: Metro = { ...refused, years: { ...refused.years, "2014": { ...refused.years["2014"], income: null } } };
    expect(withheldWhy(short, def("income_14_24"))).toBeNull();
    expect(withheldWhy(short, def("pop_14_24"))).toBe("footprint");
  });

  it("is never withheld while the rate is there", () => {
    expect(withheldWhy({ ...abilene, footprint_refused: 0.047 }, def("income_14_24"))).toBeNull();
  });

  it("is only a question for the metrics a build can withhold", () => {
    expect(canBeWithheld(def("income_14_24"))).toBe(true);
    expect(canBeWithheld(def("permits_per_1000"))).toBe(true);
    expect(canBeWithheld(def("hpi_19_24"))).toBe(false);
    expect(withheldWhy(refused, def("hpi_19_24"))).toBeNull();
  });

  it("is explained in the metric's help, apart from a metro nobody measured", () => {
    expect(metricExplainer(metricById("income_14_24"))).toContain("withheld");
    expect(metricExplainer(metricById("permits_per_1000"))).toContain("withheld");
    expect(metricExplainer(metricById("hpi_19_24"))).not.toContain("withheld");
  });
});

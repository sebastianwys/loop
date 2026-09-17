import { describe, expect, it } from "vitest";
import { SAMPLE } from "./data";
import { DEFS } from "./metrics";
import {
  DEFAULT_ROUTE, isNavigation, parseRoute, pruneMetros, routeMetric, sameRoute, writeParams, type RouteState,
} from "./route";

const route = (patch: Partial<RouteState> = {}): RouteState => ({ ...DEFAULT_ROUTE, ...patch });

// a link a reader could paste, and the state it should land on
describe("reading an address", () => {
  it("gives the defaults for an address with nothing in it", () => {
    expect(parseRoute("")).toEqual(DEFAULT_ROUTE);
    expect(parseRoute("?")).toEqual(DEFAULT_ROUTE);
    expect(parseRoute("?&&")).toEqual(DEFAULT_ROUTE);
  });

  it("reads the view, the metric, the period, the metro, the map mode and the comparison", () => {
    expect(parseRoute("?view=compare&metric=zhvi&period=2019&metro=10180&mode=shapes&compare=10180,19100")).toEqual({
      view: "compare",
      metric: "zhvi",
      period: "2019",
      metro: "10180",
      mode: "shapes",
      compare: ["10180", "19100"],
    });
  });

  it("takes the resolved metric id the app used to build, and lets it name the period", () => {
    expect(parseRoute("?metric=zhvi_2019")).toMatchObject({ metric: "zhvi", period: "2019" });
    // an explicit period is the reader's, so it wins over the one in the id
    expect(parseRoute("?metric=zhvi_2019&period=2024")).toMatchObject({ metric: "zhvi", period: "2024" });
  });
});

// the address bar is reader editable, crawlable and pasteable, so none of
// this may throw and none of it may be believed
describe("an address that cannot be trusted", () => {
  it("falls back to the first metric when the id names nothing", () => {
    expect(parseRoute("?metric=nonsense").metric).toBe(DEFAULT_ROUTE.metric);
    expect(parseRoute("?metric=").metric).toBe(DEFAULT_ROUTE.metric);
    expect(parseRoute("?metric=__proto__").metric).toBe(DEFAULT_ROUTE.metric);
    expect(parseRoute("?metric=zhvi_1066").metric).toBe(DEFAULT_ROUTE.metric);
  });

  it("forgets a period no panel is published at", () => {
    expect(parseRoute("?period=2015").period).toBeNull();
    expect(parseRoute("?period=LATEST").period).toBeNull();
    expect(parseRoute("?period[]=2019").period).toBeNull();
  });

  it("drops a metro code that is not five digits", () => {
    expect(parseRoute("?metro=abc").metro).toBeNull();
    expect(parseRoute("?metro=1018").metro).toBeNull();
    expect(parseRoute("?metro=101800").metro).toBeNull();
    expect(parseRoute("?metro=<script>alert(1)</script>").metro).toBeNull();
    // well formed but unknown survives the parse: only the loaded build knows
    // which codes are real, and it drops this one the moment it arrives
    expect(parseRoute("?metro=99999").metro).toBe("99999");
  });

  it("keeps the map on dots and the map view for a mode or view it does not have", () => {
    expect(parseRoute("?mode=SHAPES").mode).toBe("dots");
    expect(parseRoute("?mode=globe").mode).toBe("dots");
    expect(parseRoute("?view=admin").view).toBe("map");
    expect(parseRoute("?view=").view).toBe("map");
  });

  it("cleans a comparison of junk, repeats and anything past the fourth", () => {
    expect(parseRoute("?compare=,,,").compare).toEqual([]);
    expect(parseRoute("?compare=10180,10180").compare).toEqual(["10180"]);
    expect(parseRoute("?compare=10180, 19100 ,oops").compare).toEqual(["10180", "19100"]);
    expect(parseRoute("?compare=11111,22222,33333,44444,55555").compare).toEqual(["11111", "22222", "33333", "44444"]);
  });

  it("ignores keys it does not own, and never throws on any of it", () => {
    const hostile = [
      "?utm_source=news&fbclid=123",
      "?%",
      "?%zz",
      "?a=%E0%A4%A",
      "?=&=&",
      "?metric=zhvi#fragment",
      `?compare=${"9".repeat(4096)}`,
      "?view=map&view=compare",
    ];
    for (const search of hostile) expect(() => parseRoute(search)).not.toThrow();
    expect(parseRoute("?utm_source=news&fbclid=123")).toEqual(DEFAULT_ROUTE);
    // a repeated key takes the first, which is what the browser itself reads
    expect(parseRoute("?view=map&view=compare").view).toBe("map");
  });
});

describe("writing an address", () => {
  it("leaves an untouched view with no query string at all", () => {
    expect(writeParams(DEFAULT_ROUTE)).toBe("");
    expect(writeParams(route({ period: null, compare: [] }))).toBe("");
  });

  it("writes only what is not the default", () => {
    expect(writeParams(route({ metro: "10180" }))).toBe("?metro=10180");
    expect(writeParams(route({ mode: "shapes" }))).toBe("?mode=shapes");
    expect(writeParams(route({ view: "compare", compare: ["10180", "19100"] })))
      .toBe("?view=compare&compare=10180,19100");
  });

  it("carries through the keys the app does not own", () => {
    expect(writeParams(DEFAULT_ROUTE, "?utm_source=news")).toBe("?utm_source=news");
    expect(writeParams(route({ metro: "10180" }), "?utm_source=news&metro=99999"))
      .toBe("?metro=10180&utm_source=news");
  });

  it("round trips every field, in both directions", () => {
    const states = [
      DEFAULT_ROUTE,
      route({ metric: "zhvi", period: "2019" }),
      route({ view: "compare", compare: ["10180", "19100", "25980"] }),
      route({ metro: "19100", mode: "shapes", period: "latest" }),
      route({ view: "compare", metric: "zori", period: "2014", metro: "10180", mode: "shapes", compare: ["10180"] }),
    ];
    for (const state of states) expect(parseRoute(writeParams(state))).toEqual(state);
  });
});

describe("telling one state from another", () => {
  it("sees a change in any field, including the order of a comparison", () => {
    expect(sameRoute(DEFAULT_ROUTE, route())).toBe(true);
    expect(sameRoute(route({ compare: ["1", "2"] }), route({ compare: ["1", "2"] }))).toBe(true);
    expect(sameRoute(route({ compare: ["1", "2"] }), route({ compare: ["2", "1"] }))).toBe(false);
    expect(sameRoute(route({ compare: ["1"] }), route({ compare: ["1", "2"] }))).toBe(false);
    expect(sameRoute(DEFAULT_ROUTE, route({ mode: "shapes" }))).toBe(false);
    expect(sameRoute(DEFAULT_ROUTE, route({ period: "2014" }))).toBe(false);
  });
});

// the back button should undo arriving somewhere, and nothing else
describe("which changes deserve a history entry", () => {
  it("pushes for another view and for a metro opened", () => {
    expect(isNavigation(DEFAULT_ROUTE, route({ view: "compare" }))).toBe(true);
    expect(isNavigation(DEFAULT_ROUTE, route({ metro: "10180" }))).toBe(true);
    expect(isNavigation(route({ metro: "10180" }), route({ metro: "19100" }))).toBe(true);
  });

  it("replaces for a metric, a period, a map mode, a comparison, and for closing a metro", () => {
    expect(isNavigation(DEFAULT_ROUTE, route({ metric: "zhvi" }))).toBe(false);
    expect(isNavigation(DEFAULT_ROUTE, route({ period: "2014" }))).toBe(false);
    expect(isNavigation(DEFAULT_ROUTE, route({ mode: "shapes" }))).toBe(false);
    expect(isNavigation(route({ view: "compare" }), route({ view: "compare", compare: ["10180"] }))).toBe(false);
    expect(isNavigation(route({ metro: "10180" }), DEFAULT_ROUTE)).toBe(false);
  });
});

describe("codes the build does not carry", () => {
  const known = new Set(SAMPLE.metros.map((m) => m.cbsa));

  it("are dropped once the data is in", () => {
    expect(pruneMetros(route({ metro: "99999" }), known).metro).toBeNull();
    expect(pruneMetros(route({ compare: ["10180", "99999"] }), known).compare).toEqual(["10180"]);
  });

  it("leave a state that has none of them alone, object and all", () => {
    const clean = route({ metro: "10180", compare: ["10180", "19100"] });
    expect(pruneMetros(clean, known)).toBe(clean);
  });
});

describe("the metric an address names", () => {
  it("falls back to the first definition when the id is not one", () => {
    expect(routeMetric(route({ metric: "nonsense" }), SAMPLE.metros).def.id).toBe(DEFS[0].id);
  });

  it("moves to the nearest period the metric publishes, keeping the asked one in state", () => {
    const asked = route({ metric: "income", period: "latest" });
    expect(routeMetric(asked, SAMPLE.metros).period).toBe("2024");
    expect(asked.period).toBe("latest");
  });

  it("has no period at all for a metric that is a change over a span", () => {
    expect(routeMetric(route({ metric: "hpi_19_24", period: "2014" }), SAMPLE.metros).period).toBeNull();
  });
});

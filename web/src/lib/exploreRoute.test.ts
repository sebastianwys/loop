import { describe, expect, it } from "vitest";
import { SAMPLE } from "./data";
import { DEFAULT_Y, NO_AXIS, exploreMetric, parseExplore, writeExplore } from "./exploreRoute";
import { parseRoute, writeParams } from "./route";

describe("the second axis read out of an address", () => {
  it("is nothing at all when the address does not name one", () => {
    expect(parseExplore("")).toEqual(NO_AXIS);
    expect(parseExplore("?view=explore&metro=10180")).toEqual(NO_AXIS);
  });

  it("takes a bare definition id and leaves the period for the data to settle", () => {
    expect(parseExplore("?ex_y=income")).toEqual({ y: "income", period: null });
  });

  it("takes the resolved form, where the id names its own period", () => {
    expect(parseExplore("?ex_y=income_2019")).toEqual({ y: "income", period: "2019" });
  });

  it("lets the period key win over a period written into the id", () => {
    expect(parseExplore("?ex_y=income_2019&ex_yp=2024")).toEqual({ y: "income", period: "2024" });
  });

  it("falls back to no axis rather than an error when the address is hand edited into nonsense", () => {
    expect(parseExplore("?ex_y=not_a_metric&ex_yp=1066")).toEqual(NO_AXIS);
    expect(parseExplore("?ex_yp=2024")).toEqual(NO_AXIS);
    expect(parseExplore("?ex_y=income&ex_yp=1066")).toEqual({ y: "income", period: null });
  });
});

describe("the address the second axis is written into", () => {
  it("adds its own two keys and touches nothing else", () => {
    expect(writeExplore("?view=explore&metro=10180", { y: "income", period: "2024" }))
      .toBe("?view=explore&metro=10180&ex_y=income&ex_yp=2024");
  });

  it("leaves no key behind when the axis goes back to its default", () => {
    expect(writeExplore("?view=explore&ex_y=income&ex_yp=2024", NO_AXIS)).toBe("?view=explore");
    expect(writeExplore("?ex_y=income", NO_AXIS)).toBe("");
  });

  it("writes a period only when one was asked for", () => {
    expect(writeExplore("", { y: "income", period: null })).toBe("?ex_y=income");
  });

  it("leaves a list of metro codes readable rather than escaping every comma", () => {
    expect(writeExplore("?compare=10180,19100", { y: "income", period: null }))
      .toBe("?compare=10180,19100&ex_y=income");
  });

  it("reads back exactly what it wrote", () => {
    const search = writeExplore("?view=explore", { y: "permits_per_1000", period: "latest" });
    expect(parseExplore(search)).toEqual({ y: "permits_per_1000", period: "latest" });
  });
});

// the point of the prefix: route.ts owns six keys and carries every other one
// through untouched, so the second axis survives a route write and comes back
// with the rest of the address
describe("the second axis against the route that shares the address bar", () => {
  it("survives a route write, so opening a metro from the plot does not lose the axis", () => {
    const search = writeExplore("?view=explore", { y: "income", period: "2024" });
    const route = parseRoute(search);
    const after = writeParams({ ...route, metro: "10180" }, search);
    expect(after).toContain("ex_y=income");
    expect(after).toContain("ex_yp=2024");
    expect(parseExplore(after)).toEqual({ y: "income", period: "2024" });
  });

  it("is not a key the route ever reads, so it cannot change what the map draws", () => {
    const route = parseRoute("?ex_y=income&ex_yp=2024");
    expect(route).toEqual(parseRoute(""));
  });

  it("is written into the address the route left, without disturbing the route's own keys", () => {
    const route = parseRoute("?view=explore&metro=10180&metric=zhvi&period=2019");
    const search = writeParams(route, "");
    const after = writeExplore(search, { y: "income", period: null });
    expect(parseRoute(after)).toEqual(route);
  });
});

describe("the metric the second axis resolves to", () => {
  it("opens on a default that makes a real pair with the metric the map is drawn in", () => {
    expect(exploreMetric(NO_AXIS, SAMPLE.metros, "hpi_19_24").def.id).toBe(DEFAULT_Y[0]);
  });

  it("steps to the next default rather than plotting a metric against itself", () => {
    expect(exploreMetric(NO_AXIS, SAMPLE.metros, DEFAULT_Y[0]).def.id).toBe(DEFAULT_Y[1]);
  });

  it("gives a reader who asked for the same metric on both axes exactly that", () => {
    expect(exploreMetric({ y: "hpi_19_24", period: null }, SAMPLE.metros, "hpi_19_24").def.id).toBe("hpi_19_24");
  });

  it("moves a period the metric does not publish to the nearest one it does", () => {
    const y = exploreMetric({ y: "income", period: "latest" }, SAMPLE.metros, "hpi_19_24");
    expect(y.period).toBe("2024");
    expect(y.available).toEqual(["2014", "2019", "2024"]);
  });

  it("has no period at all for a change figure, which is measured between two of them", () => {
    const y = exploreMetric({ y: "hpi_19_24", period: "2024" }, SAMPLE.metros, "income");
    expect(y.period).toBeNull();
    expect(y.available).toEqual([]);
  });

  it("falls back to something with data in it when the build carries no metros at all", () => {
    expect(exploreMetric(NO_AXIS, [], "hpi_19_24").def.id).toBe(DEFAULT_Y[0]);
  });
});

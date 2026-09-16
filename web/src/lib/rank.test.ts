import { describe, expect, it } from "vitest";
import { rankMetros, searchMetros } from "./rank";
import { metricById } from "./metrics";
import { SAMPLE } from "./data";

describe("rankMetros", () => {
  it("sorts descending and skips nulls", () => {
    const ranked = rankMetros(SAMPLE.metros, metricById("hpi_19_24"));
    expect(ranked.map((r) => r.metro.cbsa)).toEqual(["19100", "10180"]);
    expect(ranked[0].value).toBeGreaterThan(ranked[1].value);
  });

  // a division that takes a metric from its parent is not a second place with
  // that number. ranking it would let one msa fill several rows of the top ten
  it("drops a value the metro inherited from its parent", () => {
    const ranked = rankMetros(SAMPLE.metros, metricById("permits_units"));
    const codes = ranked.map((r) => r.metro.cbsa);
    expect(codes).not.toContain("25980");
    // abilene measured the same 1160, and it keeps its row
    expect(codes).toContain("10180");
    expect(ranked.find((r) => r.metro.cbsa === "10180")!.value).toBe(1160);
    // no value appears twice, which is the defect this guards
    const values = ranked.map((r) => r.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("keeps a division that measured the metric itself", () => {
    // pop_estimate is not in the division's parent_metrics, so it is its own
    const ranked = rankMetros(SAMPLE.metros, metricById("pop_estimate"));
    expect(ranked.map((r) => r.metro.cbsa)).toContain("25980");
  });

  it("respects the limit", () => {
    expect(rankMetros(SAMPLE.metros, metricById("pop_14_24"), 1)).toHaveLength(1);
  });

  it("is empty when nothing has a value", () => {
    const metric = { ...metricById("hpi_19_24"), accessor: () => null };
    expect(rankMetros(SAMPLE.metros, metric)).toEqual([]);
  });
});

describe("searchMetros", () => {
  it("matches partial names case insensitively", () => {
    expect(searchMetros(SAMPLE.metros, "abil").map((m) => m.cbsa)).toEqual(["10180"]);
    expect(searchMetros(SAMPLE.metros, "TX").map((m) => m.cbsa)).toEqual(["10180", "19100"]);
  });

  it("returns nothing for a blank query", () => {
    expect(searchMetros(SAMPLE.metros, "   ")).toEqual([]);
  });

  it("caps results", () => {
    expect(searchMetros(SAMPLE.metros, "a", 2)).toHaveLength(2);
  });
});

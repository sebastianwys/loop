import { describe, expect, it } from "vitest";
import { rankMetros, searchMetros } from "./rank";
import type { Metro } from "../types";
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

// the real names, in the cbsa order the build writes them. every one of these
// contains "san" somewhere: thousand, pleasant, sanford, sandy
const SAN_METROS = [
  "Anaheim-Santa Ana-Irvine, CA",
  "Atlanta-Sandy Springs-Roswell, GA",
  "Austin-Round Rock-San Marcos, TX",
  "Orlando-Kissimmee-Sanford, FL",
  "Oxnard-Thousand Oaks-Ventura, CA",
  "Racine-Mount Pleasant, WI",
  "Riverside-San Bernardino-Ontario, CA",
  "San Angelo, TX",
  "San Antonio-New Braunfels, TX",
  "San Diego-Chula Vista-Carlsbad, CA",
  "San Francisco-San Mateo-Redwood City, CA",
  "San Jose-Sunnyvale-Santa Clara, CA",
];

const named = (names: string[]): Metro[] =>
  names.map((name, i) => ({ ...SAMPLE.metros[0], cbsa: String(10000 + i), name }));

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

  // the cap used to fall on an unranked list, so the eight slots went to
  // whatever the build wrote first and typing san offered no San Francisco
  it("fills the cap with names that start with the query", () => {
    const names = searchMetros(named(SAN_METROS), "san").map((m) => m.name);
    expect(names.slice(0, 5)).toEqual([
      "San Angelo, TX",
      "San Antonio-New Braunfels, TX",
      "San Diego-Chula Vista-Carlsbad, CA",
      "San Francisco-San Mateo-Redwood City, CA",
      "San Jose-Sunnyvale-Santa Clara, CA",
    ]);
  });

  it("puts a word starting with the query above a match inside a word", () => {
    const names = searchMetros(named([
      "Racine-Mount Pleasant, WI",
      "Riverside-San Bernardino-Ontario, CA",
      "Austin-Round Rock-San Marcos, TX",
    ]), "san").map((m) => m.name);
    expect(names[0]).toBe("Austin-Round Rock-San Marcos, TX");
    expect(names[1]).toBe("Riverside-San Bernardino-Ontario, CA");
    expect(names[2]).toBe("Racine-Mount Pleasant, WI");
  });

  // both Portlands were pushed off the list by Beaumont-Port Arthur and friends
  it("keeps a port city when the query is port", () => {
    const names = searchMetros(named([
      "Beaumont-Port Arthur, TX",
      "Bremerton-Silverdale-Port Orchard, WA",
      "Bridgeport-Stamford-Danbury, CT",
      "Davenport-Moline-Rock Island, IA-IL",
      "Gulfport-Biloxi, MS",
      "Hilton Head Island-Bluffton-Port Royal, SC",
      "Kalamazoo-Portage, MI",
      "Kingsport-Bristol, TN-VA",
      "Port St. Lucie, FL",
      "Portland-South Portland, ME",
      "Portland-Vancouver-Hillsboro, OR-WA",
    ]), "port").map((m) => m.name);
    expect(names.slice(0, 3)).toEqual([
      "Port St. Lucie, FL",
      "Portland-South Portland, ME",
      "Portland-Vancouver-Hillsboro, OR-WA",
    ]);
    expect(names).toHaveLength(8);
  });

  it("still returns every match that fits, ranked, with no cap", () => {
    const all = searchMetros(named(SAN_METROS), "san", SAN_METROS.length);
    expect(all).toHaveLength(SAN_METROS.length);
    expect(new Set(all.map((m) => m.cbsa)).size).toBe(SAN_METROS.length);
  });
});

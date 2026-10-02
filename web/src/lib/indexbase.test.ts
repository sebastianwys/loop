import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timeline, YearScrubContext } from "../components/Timeline";
import { SAMPLE } from "./data";
import { defById } from "./metrics";
import { buildDeepTimeline } from "./timeline";

// the file the site's price histories are built from
const MASTER = new URL("../../../data/raw/fhfa/hpi_master.csv", import.meta.url).pathname;

// fhfa bases every metro's index at 100 in 1995q1, so nothing on the page may
// describe it as rebased at each metro's own start
describe.skipIf(!existsSync(MASTER))("how the fhfa index is based", () => {
  it("is 100 at 1995q1 for every metro, not at each metro's own start (premise)", () => {
    const lines = readFileSync(MASTER, "utf8").split("\n");
    const at1995 = new Map<string, number>();
    const first = new Map<string, { quarter: number; value: number }>();
    for (const line of lines.slice(1)) {
      const f = line.trim().split(",");
      if (f[0] !== "traditional" || f[1] !== "all-transactions" || f[2] !== "quarterly" || f[3] !== "MSA") continue;
      // the place name carries a comma inside quotes, so the row is read from
      // the right: place_id, yr, period, index_nsa, then three empty columns
      const [place, yr, period, index] = f.slice(-7, -3);
      const quarter = Number(yr) * 4 + Number(period);
      const value = Number(index);
      if (yr === "1995" && period === "1") at1995.set(place, value);
      const seen = first.get(place);
      if (!seen || quarter < seen.quarter) first.set(place, { quarter, value });
    }
    expect(first.size).toBe(410);
    expect(at1995.size).toBeGreaterThan(400);
    expect([...new Set(at1995.values())]).toEqual([100]);
    expect([...first.values()].filter((f) => f.value === 100)).toHaveLength(0);
  });

  it("is not described on the year timeline as rebased per metro", () => {
    const hpi = defById("hpi")!.def;
    const deep = buildDeepTimeline(hpi, SAMPLE.metros)!;
    const markup = renderToStaticMarkup(createElement(
      YearScrubContext.Provider,
      { value: { deep, year: 2021, onYearChange: () => {}, reducedMotion: false } },
      createElement(Timeline, { def: hpi, metros: SAMPLE.metros, period: "latest", available: hpi.periods, onPeriodChange: () => {} }),
    ));
    const note = /<p class="mode-note">([\s\S]*?)<\/p>/.exec(markup)?.[1] ?? "";
    expect(note, "no note under the year timeline").not.toBe("");
    expect(note).not.toMatch(/rebased per metro|own start|each metro's own/);
  });
});

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defById, metricExplainer } from "./metrics";
import { buildDeepTimeline, yearMetric } from "./timeline";
import type { MapData } from "../types";

const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

// with the house price index chosen the map reads the annual history: MapPage
// hands the sidebar yearMetric(...), which borrows the index's definition and
// colours by growth into the scrubbed year, and the sidebar's question mark is
// metricExplainer of that metric
describe.skipIf(!present)("the question mark over the year timeline", () => {
  it("names the growth the map is coloured by, not the level", () => {
    const hpi = defById("hpi")!.def;
    const deep = buildDeepTimeline(hpi, data!.metros)!;
    const shown = yearMetric(hpi, deep, null);
    expect(shown.label).toBe("House price index growth, 2025 to 2026 so far");
    expect(shown.accessor(data!.metros[0])).not.toBe(data!.metros[0].series!.hpi!.values.at(-1));

    const text = metricExplainer(shown);
    expect(text, text).not.toContain("colored by its House price index at the period the timeline is set to");
    expect(text, text).toContain(shown.label);
  });
});

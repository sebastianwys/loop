// a red test. run it on purpose:
//   cd web && npx vitest run --config redtest.config.ts src/lib/fredrole.redtest.ts
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nationalIndicators, showMortgageStat } from "./indicators";
import { buildSources } from "./sources";
import type { MapData } from "../types";

const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

// the model's panel reads the same file as its mortgage input
const PANEL = new URL("../../../ml/src/loop/panel.py", import.meta.url).pathname;

// the header drops its standalone rate once a national tile carries the
// mortgage rate, and this build carries one. what the fred download feeds on
// this build is the forecast model's mortgage input
describe.skipIf(!present)("the sources page's line for the fred folder", () => {
  it("does not send the reader to a header stat this build does not show", () => {
    expect(showMortgageStat(data!.national!.mortgage_rate, nationalIndicators(data))).toBe(false);
    if (existsSync(PANEL)) expect(readFileSync(PANEL, "utf8")).toContain('FRED = "fred/mortgage30us.csv"');
    const fred = buildSources(data).rows.find((row) => row.entry.source === "fred");
    expect(fred, "no fred row").toBeDefined();
    expect(fred!.role).not.toMatch(/in the header/);
    expect(fred!.role).toMatch(/model/);
  });
});

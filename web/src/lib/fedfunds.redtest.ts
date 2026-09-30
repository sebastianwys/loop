// a red test. the build side of the same tile, which reading its chip is
// measured from, is in tests/redtest_twelve_month_change.py.
// run it deliberately, the green include does not pick a *.redtest.ts up:
//   cd web && npx vitest run --config redtest.config.ts src/lib/fedfunds.redtest.ts

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatValue } from "./format";
import { buildIndicatorChart, changeChip, displayFormat, indicatorValue, nationalIndicators, pointReadout } from "./indicators";
import type { Indicator, MapData } from "../types";

// the built json is optional in ci, so this suite skips when it is absent
const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

// the number in a printed level, "4.3%" or "Sep 2025: 4.3%"
const printed = (text: string): number => Number.parseFloat(text.split(": ").pop() ?? "");

const fedFunds = (): Indicator => nationalIndicators(data).find((i) => i.id === "fed_funds")!;

// "2026-08" twelve months earlier
const yearBack = (month: string): string => `${Number(month.slice(0, 4)) - 1}${month.slice(4, 7)}`;

// the fed sets its target in quarter points, and the tile, the chart's crosshair
// and the chart's low and high labels all print it. 4.25 printed as 4.3 is a
// target the fed never set, and a reader reading the chart against the chip
// gets a different change than the chip states
describe.skipIf(!present)("the fed funds tile and the chart drawn beside it", () => {
  it("print every level at the precision the target is set in", () => {
    const tile = fedFunds();
    const chart = buildIndicatorChart(tile.history)!;
    const format = displayFormat(tile.format);
    const shown = [
      { text: indicatorValue(tile), value: tile.value },
      ...chart.points.map((p) => ({ text: pointReadout(p, tile.format), value: p.value })),
      ...chart.values.map((v) => ({ text: `label: ${formatValue(v, format)}`, value: v })),
    ];
    const off = shown.filter((s) => printed(s.text) !== s.value).map((s) => `${s.text} for ${s.value}`);
    expect(off, `${off.length} of ${shown.length} printed levels`).toEqual([]);
  });

  // a finished month, so the chip and the chart point it is measured from are
  // the same two readings whichever way the newest, unfinished month is read
  // on the build side: august 2026 at 3.75 against august 2025 at 4.50, and the
  // change as a build that keeps the series' own precision publishes it
  it("print a chip that is the difference of the two levels printed beside it", () => {
    const shipped = fedFunds();
    const month = shipped.history[shipped.history.length - 2].date;
    const history = shipped.history.filter((p) => p.date <= month);
    const value = history[history.length - 1].value;
    const base = history.find((p) => p.date === yearBack(month))!;
    const tile: Indicator = { ...shipped, value, date: month, change_12m: value - base.value, history };

    const level = indicatorValue(tile);
    const then = pointReadout(buildIndicatorChart(tile.history)!.points.find((p) => p.date === base.date)!, tile.format);
    const chip = changeChip(tile.change_12m).text;
    expect([month, value, base.value]).toEqual(["2026-08", 3.75, 4.5]);
    expect(printed(chip), `tile ${level}, chart ${then}, chip ${chip}`)
      .toBeCloseTo(printed(level) - printed(then), 10);
  });
});

// whose coverage the detail panel's forecast explainer quotes under the band
// it sits beside
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { forecastExplainer } from "./forecast";
import { SHIPPED, points, rowAt } from "./model";
import { BACKTEST } from "./modelNumbers";
import type { MapData } from "../types";

const ROOT = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

const DATA = JSON.parse(read("web/public/data/metros.json")) as MapData;

const ASSETS = new URL("web/scripts/model-assets.mjs", ROOT).href;
type Row = Record<string, string>;
const csv = async (path: string) =>
  ((await import(ASSETS)) as { parseBacktest: (text: string) => Row[] }).parseBacktest(read(path));

describe("the explainer's coverage belongs to the band it describes", () => {
  // the band the panel draws is forecasts.csv: the refit's quantiles widened by
  // a margin fitted on 2022 onward. the coverage BACKTEST carries was measured
  // over 2022 onward on the backtest's own band, calibrated on 2018 to 2021.
  // so the two are different bands, and a number from one is not the other's
  it("names the backtest as the band whose 2022-onward coverage it quotes", async () => {
    const shipped = await csv("ml/results/forecast/forecasts.csv");
    const scored = (await csv("ml/results/backtest/seqgru.csv")).filter((r) => r.block === "test");
    const widthDrawn = (h: number) => {
      const rows = shipped.filter((r) => Number(r.horizon) === h);
      return rows.reduce((a, r) => a + Number(r.hi) - Number(r.lo), 0) / rows.length;
    };
    const widthScored = (h: number) => Number(scored.find((r) => Number(r.horizon) === h)!.width);
    const margin8 = Number(shipped.find((r) => r.horizon === "8")!.q10) - Number(shipped.find((r) => r.horizon === "8")!.lo);

    const metro = DATA.metros.find((m) => m.level === "division" && m.name.startsWith("Chicago-"))!;
    const { sentences } = forecastExplainer(metro);
    const quoted = [4, 8].map((h) => points(rowAt(BACKTEST, SHIPPED, h)!.coverage));
    const unattributed = sentences.filter((s) => quoted.some((q) => s.includes(q)) && !/backtest/i.test(s));

    expect(unattributed.length === 0 ? "attributed" :
      `quotes ${quoted.join(" and ")} for the band drawn beside it, whose mean width is `
      + `${widthDrawn(4).toFixed(3)} and ${widthDrawn(8).toFixed(3)} log units at 4q and 8q (margin ${margin8.toFixed(4)} at 8q) `
      + `against the scored band's ${widthScored(4).toFixed(3)} and ${widthScored(8).toFixed(3)}`).toBe("attributed");
  });
});

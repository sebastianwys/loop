// run: node -e "import('vitest/node').then(async(m)=>{const v=await m.startVitest('test',[],{watch:false,include:['src/lib/accuracyclaims.redtest.ts']});await v?.close();})"
// the vitest include globs only take *.test.ts, so this file stays out of the
// green run until the three defects below are closed
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccuracyPage } from "../components/AccuracyPage";
import { originOf } from "./accuracy";
import { formatValue } from "./format";
import { metricById } from "./metrics";
import { LONG_RUN, SHIPPED, asPercent, bandCut, points, type BacktestRow } from "./model";
import { DEFAULT_ROUTE } from "./route";
import type { Shell } from "./views";
import type { MapData } from "../types";

// the shipped build, not a fixture: 410 metros, the same file the site loads
const DATA = JSON.parse(
  readFileSync(new URL("../../public/data/metros.json", import.meta.url), "utf8"),
) as MapData;

const backtest = (name: string) =>
  readFileSync(new URL(`../../../ml/results/backtest/${name}`, import.meta.url), "utf8");

const ASSETS = new URL("../../scripts/model-assets.mjs", import.meta.url).href;

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

const renderAccuracy = () =>
  renderToStaticMarkup(
    createElement(AccuracyPage, {
      data: DATA,
      route: { ...DEFAULT_ROUTE, view: "accuracy" },
      go: () => {},
      viewport: { width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false },
      shell,
    }),
  );

// pandas writes a nan as an empty field, so this is what a retrain ships the
// day spec.coverage or spec.mean_width has nothing to score at one horizon
function blankCell(text: string, model: string, horizon: number, column: string): string {
  const lines = text.trim().split("\n");
  const at = lines[0].split(",").indexOf(column);
  const key = `${model},${horizon},test,`;
  return lines
    .map((line) => {
      if (!line.startsWith(key)) return line;
      const cells = line.split(",");
      cells[at] = "";
      return cells.join(",");
    })
    .join("\n");
}

describe("what the product claims about the model's own numbers", () => {
  // defect 1. the export stamps every metric with the live origin, 2026Q2,
  // but it derives the surprise from the median published four quarters
  // earlier, at 2025Q2. a scored call is dated by the quarter it was made at,
  // not by the quarter its outcome landed in, which is what the page's own
  // lead sentence, "a year ago the model published", promises the reader
  it("dates its scored forecasts at the origin the model made them at", () => {
    const footer = /Source: Loop model, origin ([A-Za-z]{3} \d{4})/.exec(renderAccuracy());
    expect(footer?.[1]).toBe("Jun 2025");
    expect(originOf(DATA.metros)).toBe("2025-06");
  });

  // defect 2. a blank cell is a metric the backtest could not score. it is
  // never a published zero, and nothing the page reads off it may turn it
  // into one
  it("treats a blank metric cell in the backtest as missing, not as zero", async () => {
    const { testRows } = (await import(ASSETS)) as { testRows: (text: string) => BacktestRow[] };
    const seqgru = blankCell(blankCell(backtest("seqgru.csv"), "seqgru", 4, "width"), "seqgru", 8, "coverage");
    const rows = [...testRows(backtest("baselines.csv")), ...testRows(seqgru)];
    const h4 = rows.find((r) => r.model === SHIPPED && r.horizon === 4)!;
    const h8 = rows.find((r) => r.model === SHIPPED && r.horizon === 8)!;

    expect(h4.width).toBeNull();
    expect(h8.coverage).toBeNull();
    // the header tile that would otherwise read "100% narrower band at four
    // quarters" against a width the backtest never published
    expect(asPercent(bandCut(rows, SHIPPED, LONG_RUN, 4))).toBeNull();
    // and the tile beside it, which would read a coverage of 0.00
    expect(points(h8.coverage)).toBe("-");
  });

  // defect 3. hpi_surprise_4q is realized growth minus expected growth, a gap
  // between two rates, so it is in percentage points. the accuracy page prints
  // it that way and the map must print the same field the same way
  it("prints the surprise in percentage points on the map, as the accuracy page does", () => {
    // this metro fell 4.9 percent against an expected 5.9, so the miss is
    // 10.8 points, not 10.8 percent of anything
    const metro = DATA.metros.find((m) => m.cbsa === "15260")!;
    const realized = metricById("hpi_yoy_latest");
    const surprise = metricById("hpi_surprise_4q");

    expect(metro.name).toBe("Brunswick-St. Simons, GA");
    expect(formatValue(realized.accessor(metro), realized.format, realized.kind === "diverging")).toBe("-4.9%");
    expect(formatValue(surprise.accessor(metro), surprise.format, surprise.kind === "diverging")).toBe("-10.8 pp");
  });
});

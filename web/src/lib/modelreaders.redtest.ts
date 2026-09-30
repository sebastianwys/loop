// red tests: the model page's readers over a metric the backtest could not
// score. modelnulls.redtest.ts covers errorCut and bandCut, which carry the
// guard now; these are the readers that do not.
// the vitest include only takes *.test.ts, so run this on purpose:
//   cd web && npx vitest run --config redtest.config.ts src/lib/modelreaders.redtest.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SHIPPED, allUnderCover, bestAt, closestTo, coverageRange, horizonsIn, lossSentence, lossesOf, type BacktestRow, type Loss,
} from "./model";

const backtest = (name: string) =>
  readFileSync(new URL(`../../../ml/results/backtest/${name}`, import.meta.url), "utf8");

const ASSETS = new URL("../../scripts/model-assets.mjs", import.meta.url).href;
type Assets = { BACKTEST_FILES: string[]; testRows: (text: string) => BacktestRow[] };

// pandas writes a nan as an empty field, so this is what a retrain ships the
// day a metric has nothing to score for one model at one horizon
function blankCell(text: string, model: string | null, horizon: number, column: string): string {
  const lines = text.trim().split("\n");
  const at = lines[0].split(",").indexOf(column);
  return lines
    .map((line, i) => {
      const cells = line.split(",");
      if (i === 0 || cells[2] !== "test" || Number(cells[1]) !== horizon || (model !== null && cells[0] !== model)) return line;
      cells[at] = "";
      return cells.join(",");
    })
    .join("\n");
}

// the published test block, with the given cells blanked, through the same
// generator that writes modelNumbers.ts
async function rowsWith(...blanks: [string | null, number, string][]): Promise<BacktestRow[]> {
  const { BACKTEST_FILES, testRows } = (await import(ASSETS)) as Assets;
  return BACKTEST_FILES.flatMap((name) =>
    testRows(blanks.reduce((text, [model, horizon, column]) => blankCell(text, model, horizon, column), backtest(name))));
}

const scored = (rows: BacktestRow[], horizon: number, key: "maePct" | "coverage") =>
  rows.filter((r) => r.horizon === horizon && Number.isFinite(r[key])).sort((a, b) => a[key] - b[key]);

// what the page should say it loses, read off the scored cells only
function scoredLosses(rows: BacktestRow[], model: string): Loss[] {
  const out: Loss[] = [];
  for (const horizon of horizonsIn(rows)) {
    const at = scored(rows, horizon, "maePct");
    const mine = at.find((r) => r.model === model);
    if (!mine || at[0].model === model) continue;
    out.push({ horizon, winner: at[0].model, margin: Math.round((mine.maePct - at[0].maePct) * 1e4) / 1e4 });
  }
  return out;
}

describe("a blank mae or coverage is missing for every reader, not zero", () => {
  it("does not crown a model the backtest could not score (bestAt)", async () => {
    const rows = await rowsWith([SHIPPED, 2, "mae_pct"]);
    expect(maeAt(rows, SHIPPED, 2)).toBeNull();
    expect(bestAt(rows, 2)?.model).toBe(scored(rows, 2, "maePct")[0].model);
  });

  it("reads the shipped model's losses off the scored rivals only (lossesOf, the page's sentence)", async () => {
    const rows = await rowsWith(["ridge", 1, "mae_pct"]);
    const expected = scoredLosses(rows, SHIPPED);
    expect(lossSentence(lossesOf(rows, SHIPPED))).toBe(lossSentence(expected));
    expect(lossesOf(rows, SHIPPED)).toEqual(expected);
  });

  it("names no nearest rival when the shipped model has no eight quarter score (closestTo)", async () => {
    const rows = await rowsWith([SHIPPED, 8, "mae_pct"]);
    expect(closestTo(rows, SHIPPED, 8)).toBeNull();
  });

  it("spans the eight quarter coverage of the scored models only (coverageRange)", async () => {
    const rows = await rowsWith([SHIPPED, 8, "coverage"]);
    const at = scored(rows, 8, "coverage");
    const range = coverageRange(rows, 8);
    expect({ low: range?.low.model, high: range?.high.model })
      .toEqual({ low: at[0].model, high: at[at.length - 1].model });
  });

  // allUnderCover is not on the page today; its answer only goes wrong when
  // nothing at the horizon was scored, which is the case pinned here
  it("does not say every model under-covers when no model was scored (allUnderCover, coverageRange)", async () => {
    const rows = await rowsWith([null, 8, "coverage"]);
    expect(scored(rows, 8, "coverage")).toEqual([]);
    expect(allUnderCover(rows, 8)).toBe(false);
    expect(coverageRange(rows, 8)).toBeNull();
  });
});

// the mae cell the blank landed in, to show the generator did emit a null
function maeAt(rows: BacktestRow[], model: string, horizon: number): number | null {
  return rows.find((r) => r.model === model && r.horizon === horizon)!.maePct as number | null;
}

// a red test for the audit's model.ts nullability finding. run it deliberately,
// the vitest include does not pick a *.redtest.ts up:
//   node -e "import('vitest/node').then(async(m)=>{const v=await m.startVitest('test',[],{watch:false,include:['src/lib/modelnulls.redtest.ts']});await v?.close();})"

import { describe, expect, it } from "vitest";
import { errorCut, bandCut } from "./model";
import type { BacktestRow } from "./model";

// the generator emits null for a metric the backtest could not score. these two
// readings divide one model's number by another's, so a null read as zero
// claims the strongest possible result rather than no result
function row(model: string, horizon: number, maePct: number | null, width: number | null): BacktestRow {
  return { model, horizon, n: 100, maePct, coverage: 0.9, width } as unknown as BacktestRow;
}

describe("a reading over a metric the backtest could not score", () => {
  it("does not claim a hundred percent less error when this model has no mae", () => {
    const rows = [row("seqgru", 4, null, 0.17), row("no_change", 4, 3.2, 0.24)];
    expect(errorCut(rows, "seqgru", "no_change", 4)).toBeNull();
  });

  it("does not claim a hundred percent more error when the rival has no mae", () => {
    const rows = [row("seqgru", 4, 2.0, 0.17), row("no_change", 4, null, 0.24)];
    expect(errorCut(rows, "seqgru", "no_change", 4)).toBeNull();
  });

  // the control: two real numbers still divide
  it("still reads a real pair", () => {
    const rows = [row("seqgru", 4, 1.6, 0.17), row("no_change", 4, 3.2, 0.24)];
    expect(errorCut(rows, "seqgru", "no_change", 4)).toBeCloseTo(0.5, 4);
  });

  // bandCut was fixed for this already; it is here so a later change cannot
  // quietly take the guard back out
  it("keeps the band reading null when a width is missing", () => {
    const rows = [row("seqgru", 4, 1.6, null), row("no_change", 4, 3.2, 0.24)];
    expect(bandCut(rows, "seqgru", "no_change", 4)).toBeNull();
  });
});

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "../lib/data";
import { DetailPanel, historyNote } from "./DetailPanel";
import type { AnnualSeries } from "../types";

// no dom in this suite, so the markup is read as a string
const html = (node: ReactElement) => renderToStaticMarkup(node);
const metro = (cbsa: string) => SAMPLE.metros.find((m) => m.cbsa === cbsa)!;
const panel = (cbsa: string) => html(<DetailPanel metro={metro(cbsa)} metros={SAMPLE.metros} onClose={() => {}} />);

describe("a number the metro took from its parent", () => {
  // the footer note names the whole set, but a reader looking at one row sees
  // a figure with nothing on it. the mark belongs beside the number
  it("marks the row, not just the footer", () => {
    const markup = panel("25980");
    // the division inherits permits_units and inventory from abilene
    expect(markup).toContain("From the parent metro");
    // and each inherited row says so where the number is
    const marks = markup.split("from the parent").length - 1;
    expect(marks).toBeGreaterThanOrEqual(1);
  });

  it("leaves a metro's own numbers unmarked", () => {
    const markup = panel("10180");
    expect(markup).not.toContain("from the parent");
    expect(markup).not.toContain("From the parent metro");
  });

  // zillow's series ride on zillow_scope, not parent_metrics. an unmarked row
  // has to mean "this metro measured it", so both mechanisms mark
  it("marks a zillow series a division took whole", () => {
    const taken = { ...metro("25980"), zillow_scope: "parent metro" as const };
    const markup = html(<DetailPanel metro={taken} metros={SAMPLE.metros} onClose={() => {}} />);
    expect(markup).toContain("Zillow values are for the parent metro");
    expect(markup.split("from the parent").length - 1).toBeGreaterThan(1);
  });

  // the row mark stays short; the header line and the footer note are where
  // the parent is named, so the measure column does not wrap to seven lines
  it("names the parent elsewhere in the panel", () => {
    const markup = panel("25980");
    expect(markup).toContain("Abilene, TX");
    expect(markup).toContain("From the parent metro: ");
  });
});

// the last point used to be a mean of however much of the year had been
// published, drawn on a line of full-year means and labelled as that year
describe("the note under the price history", () => {
  const full: AnnualSeries = { start: 2000, values: [100, 110], as_of: "2001Q4", partial_year: null };
  const short: AnnualSeries = { start: 2000, values: [100, 112], as_of: "2001Q2", partial_year: 2001 };

  it("says the last point is a quarter when the year is short", () => {
    const note = historyNote(short, false);
    expect(note).toContain("through 2000");
    expect(note).toContain("the index at 2001Q2");
    expect(note).toContain("not a full year");
  });

  it("says nothing about quarters when the year is complete", () => {
    const note = historyNote(full, false);
    expect(note).toBe("Annual mean of the index, through 2001.");
  });

  it("keeps the forecast sentence either way", () => {
    expect(historyNote(short, true)).toContain("90 percent band");
    expect(historyNote(full, true)).toContain("90 percent band");
  });
});

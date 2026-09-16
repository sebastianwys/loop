import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "../lib/data";
import { DetailPanel } from "./DetailPanel";

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

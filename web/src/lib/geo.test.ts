import { describe, expect, it } from "vitest";
import { footprintNote, geoNote, parentMetricsNote } from "./geo";
import type { Metro } from "../types";

const base = { cbsa: "1", name: "x", lat: 0, lon: 0 } as unknown as Metro;

describe("geoNote", () => {
  it("says nothing for a plain metro", () => {
    expect(geoNote({ ...base, level: "msa", parent: null, zillow_scope: "metro" })).toBeNull();
  });

  it("names the parent and the zillow scope for a division", () => {
    const m = { ...base, level: "division", parent: { cbsa: "16980", name: "Chicago-Naperville-Elgin, IL-IN" }, zillow_scope: "parent metro" } as Metro;
    expect(geoNote(m)).toBe("Metropolitan division of Chicago-Naperville-Elgin, IL-IN. Zillow values are for the parent metro.");
  });

  it("skips the zillow sentence when there are no zillow values", () => {
    const m = { ...base, level: "division", parent: { cbsa: "16980", name: "Chicago" }, zillow_scope: null } as Metro;
    expect(geoNote(m)).toBe("Metropolitan division of Chicago.");
  });

  it("handles data without the new fields", () => {
    expect(geoNote(base)).toBeNull();
  });
});

describe("parentMetricsNote", () => {
  it("is null without inherited metrics", () => {
    expect(parentMetricsNote(base)).toBeNull();
    expect(parentMetricsNote({ ...base, parent_metrics: [] })).toBeNull();
  });

  it("lists inherited metrics by label, deduplicated, unknown keys as they are", () => {
    const m = { ...base, parent_metrics: ["permits_units", "inventory", "permits_units", "mystery"] };
    expect(parentMetricsNote(m)).toBe("From the parent metro: Housing units permitted, For sale inventory, mystery.");
  });
});

// omb tidies a boundary far more often than it redraws a metro, and a change
// too small to move the rate is reported rather than withheld. the note is what
// keeps that from being a silent claim
describe("footprintNote", () => {
  it("says nothing for a metro whose lines never moved", () => {
    expect(footprintNote(base)).toBeNull();
    expect(footprintNote({ ...base, footprint_moved: undefined })).toBeNull();
  });

  it("names the share that changed hands", () => {
    const note = footprintNote({ ...base, footprint_moved: 0.0046 });
    expect(note).toContain("0.46 percent");
    expect(note).toContain("close rather than identical");
  });

  // lynchburg lost a county that carries nobody, since bedford city merged into
  // bedford county. "0.00 percent" would read as a rounding artefact
  it("says under a hundredth rather than printing a zero", () => {
    expect(footprintNote({ ...base, footprint_moved: 0 })).toContain("under 0.01 percent");
  });

  // the note has to say where the rule stops, or a reader cannot tell this from
  // a metro that was redrawn outright and reports nothing
  it("names the tolerance so the silence on other metros is explained", () => {
    expect(footprintNote({ ...base, footprint_moved: 0.01 })).toContain("more than two percent");
  });

  it("ignores a value that is not a share", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(footprintNote({ ...base, footprint_moved: bad }), String(bad)).toBeNull();
    }
  });

  // cleveland gained ashtabula, 4.5 percent of its people, so its decade rates
  // are withheld. before this the three blank cells read exactly like a metro
  // nobody had measured, which is a different claim
  it("says withheld, not missing, when the move was too far for a rate", () => {
    const note = footprintNote({ ...base, footprint_refused: 0.0447 });
    expect(note).toContain("4.47 percent");
    expect(note).toContain("withheld");
    expect(note).not.toContain("close rather than identical");
  });

  it("prefers the withheld wording when a metro somehow carries both", () => {
    const note = footprintNote({ ...base, footprint_moved: 0.001, footprint_refused: 0.05 });
    expect(note).toContain("withheld");
  });

  it("ignores a refused value that is not a share", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(footprintNote({ ...base, footprint_refused: bad }), String(bad)).toBeNull();
    }
  });
});

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

  // the change table holds fhfa's two price changes too, printed, so the note
  // names the three acs rates the county lines touch rather than all of them
  it("names the rates the moved lines touch, not every change in the table", () => {
    const withheld = footprintNote({ ...base, footprint_refused: 0.0447 })!;
    expect(withheld).not.toContain("so the changes above are withheld");
    expect(withheld).toContain("so the income, home value and population changes above are withheld");
    const moved = footprintNote({ ...base, footprint_moved: 0.0046 })!;
    expect(moved).toContain("so the income, home value and population changes above compare footprints");
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

  // the measure is people gained plus people lost over the earlier base, so
  // connecticut's swap of counties for planning regions comes to about two.
  // that is a turnover, and no share of a metro's people passes a hundred
  it("says how many times over a turnover past one is, never a percent of people", () => {
    const note = footprintNote({ ...base, footprint_refused: 2.0237 })!;
    expect(note).toContain("2.02 times its population at the earlier vintage");
    expect(note).not.toMatch(/\d+(\.\d+)? percent of its people/);
    expect(note).toContain("withheld");
  });

  // hartford's swap came to 1.9489 and new haven's to 1.6611: short of two,
  // past one, and no more a share of anybody than bridgeport's. a full one is
  // still a share, every person the metro had
  it("words a turnover between one and two as times over too", () => {
    const hartford = footprintNote({ ...base, footprint_refused: 1.9489 })!;
    expect(hartford).toContain("1.95 times its population at the earlier vintage");
    expect(hartford).not.toMatch(/\d+(\.\d+)? percent of its people/);
    expect(footprintNote({ ...base, footprint_refused: 1.6611 })).toContain("1.66 times its population");
    expect(footprintNote({ ...base, footprint_refused: 1 })).toContain("100.00 percent of its people");
  });

  // a move nobody could weigh is withheld too. the build used to write 1.0 in
  // place of the share, which read as a metro that lost every person it had
  it("says a move nobody could weigh is withheld, without a share it does not have", () => {
    const note = footprintNote({ ...base, footprint_unweighed: true })!;
    expect(note).toContain("could not be weighed");
    expect(note).toContain("withheld rather than measured");
    expect(note).not.toMatch(/percent|times/);
    expect(footprintNote({ ...base, footprint_unweighed: true, footprint_moved: 0.004 })).toContain("could not be weighed");
    expect(footprintNote({ ...base, footprint_unweighed: false })).toBeNull();
  });
});

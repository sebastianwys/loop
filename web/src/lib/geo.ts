import type { Metro } from "../types";
import { isInherited, labelFor, type MetricDef } from "./metrics";

// the zillow series a division takes whole from its parent metro
const ZILLOW_OWN = new Set(["zhvi", "zori"]);

// one line under a metro name: what a division belongs to, and where its
// zillow values come from. null when there is nothing to say
export function geoNote(metro: Metro): string | null {
  const parts: string[] = [];
  if (metro.level === "division" && metro.parent) {
    parts.push(`Metropolitan division of ${metro.parent.name}`);
  }
  if (metro.zillow_scope === "parent metro") {
    parts.push("Zillow values are for the parent metro");
  }
  return parts.length ? parts.join(". ") + "." : null;
}

// the enrichment metrics a division took from its parent, by their labels
export function parentMetricsNote(metro: Metro): string | null {
  const keys = metro.parent_metrics ?? [];
  if (keys.length === 0) return null;
  const labels = Array.from(new Set(keys.map(labelFor)));
  return `From the parent metro: ${labels.join(", ")}.`;
}

// omb tidies a metro's boundary far more often than it redraws one, and a
// change too small to move the rate is reported rather than withheld. the note
// is what keeps that from being a silent claim: the rates below are this
// metro's, over a footprint that is not quite the same in both vintages
export function footprintNote(metro: Metro): string | null {
  const moved = metro.footprint_moved;
  if (typeof moved !== "number" || !Number.isFinite(moved) || moved < 0) return null;
  const share = moved < 0.0001 ? "under 0.01 percent" : `${(moved * 100).toFixed(2)} percent`;
  return `The county lines of this metro moved between the two vintages, carrying ${share} of its people, `
    + "so the changes above compare footprints that are close rather than identical. A metro redrawn by more "
    + "than two percent reports no change at all.";
}

// the mark that rides next to one inherited figure. the footer note names the
// whole set and geoNote names the parent, so the row itself stays short: the
// full parent name here wrapped a measure cell to seven lines
export function inheritedFrom(metro: Metro, def: MetricDef): string | null {
  // zillow's own series are inherited through zillow_scope rather than
  // parent_metrics, so they need naming here too. without this an unmarked row
  // would falsely read as "this metro measured it"
  const zillowTaken = metro.zillow_scope === "parent metro" && ZILLOW_OWN.has(def.id);
  return isInherited(metro, def) || zillowTaken ? "from the parent" : null;
}

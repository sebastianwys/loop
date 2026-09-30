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

// the settled measure is a turnover: the people in the counties a metro gained
// plus the people in the ones it lost, over what it held at the earlier
// vintage. a complete swap comes to about two, which is not a share of anybody,
// so past one the note says how many times over rather than a percent of
// people no metro has
function turnover(value: number): string {
  if (value > 1) {
    return `the people in the counties it gained and lost number ${value.toFixed(2)} times its population at the earlier vintage`;
  }
  const part = value < 0.0001 ? "under 0.01 percent" : `${(value * 100).toFixed(2)} percent`;
  return `the counties it gained and lost held ${part} of its people`;
}

// a measured share is a finite number no smaller than zero
const share = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

// the change table also holds fhfa's two price changes, and fhfa builds every
// year of its index on today's county lines, so the note names the three acs
// rates the moved lines touch rather than every change above it
const DECADE_RATES = "the income, home value and population changes above";

const WITHHELD_TAIL = `so ${DECADE_RATES} are withheld rather than measured across two different places. The year `
  + "figures are each their own vintage's and stand on their own.";

// omb tidies a metro's boundary far more often than it redraws one, and a
// change too small to move the rate is reported rather than withheld. the note
// is what keeps that from being a silent claim: the rates below are this
// metro's, over a footprint that is not quite the same in both vintages.
//
// past the tolerance the rate is withheld instead, and then the note carries
// the whole weight: without it the blank reads as a metro nobody measured. a
// move nobody could weigh is withheld too, and says so rather than printing a
// share it does not have
export function footprintNote(metro: Metro): string | null {
  if (metro.footprint_unweighed === true) {
    return "The county lines of this metro were redrawn between the two vintages, and the share of its people "
      + `that changed hands could not be weighed, ${WITHHELD_TAIL}`;
  }
  const refused = metro.footprint_refused;
  if (share(refused)) {
    return `The county lines of this metro were redrawn between the two vintages: ${turnover(refused)}, which is `
      + `past the two percent this map will report a change over, ${WITHHELD_TAIL}`;
  }
  const moved = metro.footprint_moved;
  if (!share(moved)) return null;
  return `The county lines of this metro moved between the two vintages: ${turnover(moved)}, so ${DECADE_RATES} `
    + "compare footprints that are close rather than identical. A metro redrawn by more than two percent reports "
    + "no change at all.";
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

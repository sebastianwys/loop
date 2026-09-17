import type { ScaleKind } from "./metrics";
import { DIVERGING, NULL_GRAY, SEQUENTIAL } from "./palette";

export interface Bin {
  from: number;
  to: number;
  color: string;
}

export interface ColorScale {
  kind: ScaleKind;
  domain: [number, number] | null;
  bins: Bin[];
  // true when the end classes take everything past the domain, so the legend
  // says "or more" rather than naming an edge the values plainly carry past
  clipped: boolean;
  color: (value: number | null) => string;
}

const finite = (values: (number | null)[]) =>
  values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

// where a diverging domain ends, as a quantile of the magnitudes rather than at
// the largest one. the domain used to run to the biggest number in the data, so
// a single outlier set the width of all five classes and everything ordinary
// fell into the neutral middle: net domestic migration put 404 of 410 metros in
// one class, and net natural change 395. measured over the built map at this
// quantile they are 305 and 301, and every class carries metros.
//
// this is the rule the animated annual run has always used, for the same reason
// and with the same finding written beside it: a domain wide enough to hold the
// extreme washes out everything else. the end classes take what is past them
const DIVERGING_QUANTILE = 0.95;

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// whether a run ever changes sign. all zeros is not one sided: nothing about
// it points a direction, and the diverging ramp's neutral middle is the honest
// colour for it
function oneSided(data: number[]): boolean {
  return data.some((v) => v > 0) !== data.some((v) => v < 0);
}

// five classes, the documented ramp length. sequential bins are quantiles so
// every class carries metros; diverging bins are equal width and symmetric
// around zero so the middle class is the neutral gray.
//
// a diverging ramp is a claim that the two directions are different kinds of
// thing, and the symmetry around zero is what makes the middle neutral. that
// is right for net migration, where a metro can lose people, and wrong for a
// run no metro is on the wrong side of: house price growth 2019 to 2024 is
// positive in all 395 metros that have it, so two of the five classes hold
// nobody and the legend advertises them anyway, with the whole country inside
// the top two. a run that never changes sign is read on the sequential ramp
export function buildScale(values: (number | null)[], asked: ScaleKind): ColorScale {
  const data = finite(values);
  if (data.length === 0) {
    return { kind: asked, domain: null, bins: [], clipped: false, color: () => NULL_GRAY };
  }

  const kind: ScaleKind = asked === "diverging" && oneSided(data) ? "sequential" : asked;
  const colors = kind === "diverging" ? DIVERGING : SEQUENTIAL;
  const n = colors.length;
  let breaks: number[];
  let clipped = false;

  if (kind === "diverging") {
    const magnitudes = data.map(Math.abs).sort((a, b) => a - b);
    const largest = magnitudes[magnitudes.length - 1];
    const max = quantile(magnitudes, DIVERGING_QUANTILE) || largest || 1;
    clipped = max < largest;
    breaks = Array.from({ length: n + 1 }, (_, i) => -max + (2 * max * i) / n);
  } else {
    const sorted = [...data].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    if (min === max) {
      const only: Bin = { from: min, to: max, color: colors[Math.floor(n / 2)] };
      return {
        kind,
        domain: [min, max],
        bins: [only],
        clipped: false,
        color: (v) => (v === null || !Number.isFinite(v) ? NULL_GRAY : only.color),
      };
    }
    breaks = Array.from({ length: n + 1 }, (_, i) => quantile(sorted, i / n));
    // heavy ties collapse quantile breaks, fall back to equal width
    const increasing = breaks.every((b, i) => i === 0 || b > breaks[i - 1]);
    if (!increasing) {
      breaks = Array.from({ length: n + 1 }, (_, i) => min + ((max - min) * i) / n);
    }
  }

  const bins = colors.map((color, i) => ({ from: breaks[i], to: breaks[i + 1], color }));
  const domain: [number, number] = [breaks[0], breaks[n]];
  const color = (v: number | null) => {
    if (v === null || !Number.isFinite(v)) return NULL_GRAY;
    if (v <= domain[0]) return bins[0].color;
    if (v >= domain[1]) return bins[n - 1].color;
    const hit = bins.find((b) => v >= b.from && v < b.to);
    return (hit ?? bins[n - 1]).color;
  };
  return { kind, domain, bins, clipped, color };
}

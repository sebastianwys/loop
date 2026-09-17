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
  color: (value: number | null) => string;
}

const finite = (values: (number | null)[]) =>
  values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

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
    return { kind: asked, domain: null, bins: [], color: () => NULL_GRAY };
  }

  const kind: ScaleKind = asked === "diverging" && oneSided(data) ? "sequential" : asked;
  const colors = kind === "diverging" ? DIVERGING : SEQUENTIAL;
  const n = colors.length;
  let breaks: number[];

  if (kind === "diverging") {
    const max = Math.max(...data.map(Math.abs)) || 1;
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
  return { kind, domain, bins, color };
}

import type { Metro } from "../types";
import { isInherited, type Metric } from "./metrics";

export interface Ranked {
  metro: Metro;
  value: number;
}

// descending, nulls dropped, optional cap. a value a division took from its
// parent is dropped too: it is the parent's measurement, and ranking it let one
// msa fill several rows of the same top ten under different names
export function rankMetros(metros: Metro[], metric: Metric, limit?: number): Ranked[] {
  const rows: Ranked[] = [];
  for (const metro of metros) {
    if (isInherited(metro, metric)) continue;
    const value = metric.accessor(metro);
    if (value !== null) rows.push({ metro, value });
  }
  rows.sort((a, b) => b.value - a.value);
  return limit === undefined ? rows : rows.slice(0, limit);
}

// case insensitive substring match on the name
export function searchMetros(metros: Metro[], query: string, limit = 8): Metro[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return metros.filter((m) => m.name.toLowerCase().includes(q)).slice(0, limit);
}

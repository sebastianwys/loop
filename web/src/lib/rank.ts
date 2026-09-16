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

// how well a name answers the query: 0 the name starts with it, 1 a word in the
// name starts with it, 2 it appears inside a word. -1 is no match
function matchRank(name: string, q: string): number {
  const lower = name.toLowerCase();
  if (lower.startsWith(q)) return 0;
  if (!lower.includes(q)) return -1;
  return lower.split(/[^a-z0-9]+/).some((word) => word.startsWith(q)) ? 1 : 2;
}

// case insensitive match on the name, best answers first. the cap falls after
// the ranking: applying it to the build's own order meant typing "san" spent
// all eight slots on Thousand Oaks and Mount Pleasant and never reached San
// Francisco
export function searchMetros(metros: Metro[], query: string, limit = 8): Metro[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: { metro: Metro; rank: number }[] = [];
  for (const metro of metros) {
    const rank = matchRank(metro.name, q);
    if (rank >= 0) hits.push({ metro, rank });
  }
  hits.sort((a, b) => a.rank - b.rank || a.metro.name.localeCompare(b.metro.name));
  return hits.slice(0, limit).map((h) => h.metro);
}

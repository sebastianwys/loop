import { useCallback, useEffect, useState } from "react";
import type { Metro, Period } from "../types";
import {
  DEFS, PERIODS, availablePeriods, defById, nearestPeriod, resolveMetric, visibleDefs,
  type Metric, type MetricDef,
} from "./metrics";

// route.ts owns view, metric, period, metro, mode and compare, and it carries
// every other query key it finds through writeParams untouched. so the second
// axis parks under a prefix of its own: it survives every route write, it
// comes back with the rest of the address on the back button, and it cannot
// collide with a key that view ever grows
export const Y_KEY = "ex_y";
export const Y_PERIOD_KEY = "ex_yp";

// the x axis is the route's own metric, the one the map is drawn in, so a
// reader who arrives from the map keeps looking at what they were looking at
export interface ExploreAxis {
  y: string | null;
  period: Period | null;
}

export const NO_AXIS: ExploreAxis = { y: null, period: null };

// the y a fresh address opens on, first one with data wins. against the map's
// own default metric, price growth 2019 to 2024, the first of these is a real
// question rather than two metrics picked out of a hat: does the building
// follow the prices
export const DEFAULT_Y = ["permits_per_1000", "domestic_migration_rate", "hpi_forecast_4q", "income"];

function params(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

function readPeriod(raw: string | null): Period | null {
  return PERIODS.includes(raw as Period) ? (raw as Period) : null;
}

// the same shape route.ts reads its own metric in: a bare definition id, or
// the resolved form like income_2024, which names a period when no period key
// is there to name one
export function parseExplore(search: string): ExploreAxis {
  const p = params(search);
  const raw = p.get(Y_KEY);
  const hit = raw === null ? null : defById(raw);
  if (!hit) return NO_AXIS;
  const declared = readPeriod(p.get(Y_PERIOD_KEY));
  return { y: hit.def.id, period: declared ?? (raw === hit.def.id ? null : hit.period) };
}

// the address with these two keys set, and everything else exactly as it was
// found. an axis left at its default writes no key at all, which is the rule
// route.ts writes its own address by
export function writeExplore(search: string, axis: ExploreAxis): string {
  const p = params(search);
  if (axis.y === null) p.delete(Y_KEY);
  else p.set(Y_KEY, axis.y);
  if (axis.period === null) p.delete(Y_PERIOD_KEY);
  else p.set(Y_PERIOD_KEY, axis.period);
  // route.ts leaves commas alone in a list of codes, and an address that two
  // writers disagree about would be rewritten on every render
  const query = p.toString().replace(/%2C/g, ",");
  return query ? `?${query}` : "";
}

export interface ExploreMetric {
  def: MetricDef;
  metric: Metric;
  period: Period | null;
  available: Period[];
}

// the default only avoids the metric already on the other axis. a reader who
// asks for the same metric twice gets it: the identity line is a fair way to
// check what the plot does
function fallbackDef(metros: Metro[], avoid: string): MetricDef {
  const visible = visibleDefs(metros);
  for (const id of DEFAULT_Y) {
    const def = visible.find((d) => d.id === id && d.id !== avoid);
    if (def) return def;
  }
  return visible.find((d) => d.id !== avoid) ?? DEFS[0];
}

// the y axis read against the data it will be drawn from, the way routeMetric
// reads the x: an unknown id falls back to a default with values in it, and a
// period the metric does not publish moves to the nearest one it does
export function exploreMetric(axis: ExploreAxis, metros: Metro[], avoid: string): ExploreMetric {
  const def = (axis.y === null ? null : defById(axis.y)?.def) ?? fallbackDef(metros, avoid);
  const available = availablePeriods(def, metros);
  const period = nearestPeriod(axis.period, available);
  return { def, metric: resolveMetric(def, period), period, available };
}

function search(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

// the y axis lives in the address bar beside the route, so a finding is a
// link. changing an axis is a recolouring rather than a destination, which is
// the same call route.ts makes for the metric the map is drawn in, so it
// replaces the history entry instead of pushing one
export function useExploreAxis(): { axis: ExploreAxis; setAxis: (patch: Partial<ExploreAxis>) => void } {
  const [axis, set] = useState<ExploreAxis>(() => parseExplore(search()));

  useEffect(() => {
    const onPop = () => set(parseExplore(search()));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const next = writeExplore(search(), axis);
    if (next === search()) return;
    window.history.replaceState(null, "", `${window.location.pathname}${next}${window.location.hash}`);
  }, [axis]);

  const setAxis = useCallback((patch: Partial<ExploreAxis>) => set((a) => ({ ...a, ...patch })), []);
  return { axis, setAxis };
}

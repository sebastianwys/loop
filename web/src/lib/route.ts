import { useCallback, useEffect, useRef, useState } from "react";
import type { Metro, Period } from "../types";
import type { MapMode } from "./boundaries";
import { MAX_COMPARE } from "./compare";
import {
  DEFS, PERIODS, availablePeriods, defById, nearestPeriod, resolveMetric, type Metric, type MetricDef,
} from "./metrics";

// the views the address bar can name. a new view adds its id here and its
// entry in views.ts, and tsc names the missing half if only one is done
export const VIEW_IDS = ["map", "compare", "explore", "accuracy", "model", "sources"] as const;
export type ViewId = (typeof VIEW_IDS)[number];

const MODES: readonly MapMode[] = ["dots", "shapes"];

// five digits, the shape of every cbsa and division code in the build. a code
// that is well formed but names no metro is dropped later, once data is in
const CODE = /^[0-9]{5}$/;

// the whole of the shareable state. what is left in react is either derived
// from the data or a local preference, like the width the sidebar was dragged to
export interface RouteState {
  view: ViewId;
  metric: string;
  // the period the reader asked for, not the one on screen: a metric that
  // does not publish it draws the nearest, and the ask survives the detour
  period: Period | null;
  metro: string | null;
  mode: MapMode;
  compare: string[];
}

export const DEFAULT_ROUTE: RouteState = {
  view: "map",
  metric: DEFS[0].id,
  period: null,
  metro: null,
  mode: "dots",
  compare: [],
};

// the keys this app owns. everything else in a query string belongs to
// somebody else and is carried through untouched
const KEYS = ["view", "metric", "period", "metro", "mode", "compare"] as const;

// URLSearchParams is lenient: a stray percent or a bare "=" becomes a junk
// key rather than a throw, and a junk key is not one that is ever read
function params(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

function one<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

function readPeriod(raw: string | null): Period | null {
  return PERIODS.includes(raw as Period) ? (raw as Period) : null;
}

// a definition id, also taking the resolved form like income_2024, which
// names a period of its own when the address bar carries none
function readMetric(raw: string | null, period: Period | null): { metric: string; period: Period | null } {
  const hit = raw === null ? null : defById(raw);
  if (!hit) return { metric: DEFAULT_ROUTE.metric, period };
  return { metric: hit.def.id, period: period ?? (raw === hit.def.id ? null : hit.period) };
}

function readCode(raw: string | null): string | null {
  return raw !== null && CODE.test(raw) ? raw : null;
}

function readCodes(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const code = readCode(part.trim());
    if (code && !out.includes(code) && out.length < MAX_COMPARE) out.push(code);
  }
  return out;
}

// whatever the query string holds, this returns a state the app can draw.
// anything unreadable falls back to the default, so a hostile or hand edited
// link lands on the plain map rather than on an error
export function parseRoute(search: string): RouteState {
  const p = params(search);
  const { metric, period } = readMetric(p.get("metric"), readPeriod(p.get("period")));
  return {
    view: one(p.get("view"), VIEW_IDS, DEFAULT_ROUTE.view),
    metric,
    period,
    metro: readCode(p.get("metro")),
    mode: one(p.get("mode"), MODES, DEFAULT_ROUTE.mode),
    compare: readCodes(p.get("compare")),
  };
}

// the address for a state: the keys this app owns in a fixed order, defaults
// left out so an untouched view has a clean address, then the foreign keys
// the reader arrived with
export function writeParams(route: RouteState, current = ""): string {
  const out = new URLSearchParams();
  if (route.view !== DEFAULT_ROUTE.view) out.set("view", route.view);
  if (route.metric !== DEFAULT_ROUTE.metric) out.set("metric", route.metric);
  if (route.period !== null) out.set("period", route.period);
  if (route.metro !== null) out.set("metro", route.metro);
  if (route.mode !== DEFAULT_ROUTE.mode) out.set("mode", route.mode);
  if (route.compare.length > 0) out.set("compare", route.compare.join(","));
  const foreign = params(current);
  for (const key of KEYS) foreign.delete(key);
  for (const [key, value] of foreign) out.append(key, value);
  // a comma is legal in a query value, and a list of codes reads better with
  // commas in it than with %2C three times over
  const query = out.toString().replace(/%2C/g, ",");
  return query ? `?${query}` : "";
}

export function sameRoute(a: RouteState, b: RouteState): boolean {
  return a.view === b.view && a.metric === b.metric && a.period === b.period && a.metro === b.metro
    && a.mode === b.mode && a.compare.length === b.compare.length && a.compare.every((c, i) => c === b.compare[i]);
}

// which history entry a change deserves. arriving somewhere new is what the
// back button should undo: another view, or a metro opened. recolouring the
// same map, or closing a metro, is not a destination, and pushing those would
// leave the reader clicking back a dozen times to get off the page
export function isNavigation(from: RouteState, to: RouteState): boolean {
  if (to.view !== from.view) return true;
  return to.metro !== null && to.metro !== from.metro;
}

// codes that name no metro in this build are dropped once the data is in, so
// a stale link stops pointing at something that is not there. the same object
// comes back when there is nothing to drop, so react state does not churn
export function pruneMetros(route: RouteState, known: Set<string>): RouteState {
  const metro = route.metro !== null && !known.has(route.metro) ? null : route.metro;
  const compare = route.compare.filter((code) => known.has(code));
  if (metro === route.metro && compare.length === route.compare.length) return route;
  return { ...route, metro, compare };
}

export interface RouteMetric {
  def: MetricDef;
  metric: Metric;
  period: Period | null;
  available: Period[];
}

// the metric the address bar names, read against the data it will be drawn
// from: an unknown id falls back to the first definition, and a period the
// metric does not publish moves to the nearest one it does
export function routeMetric(route: RouteState, metros: Metro[]): RouteMetric {
  const def = (defById(route.metric) ?? { def: DEFS[0] }).def;
  const available = availablePeriods(def, metros);
  const period = nearestPeriod(route.period, available);
  return { def, metric: resolveMetric(def, period), period, available };
}

export type Go = (patch: Partial<RouteState> | ((route: RouteState) => Partial<RouteState>)) => void;

function search(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

// the address bar is where this state lives, so every view is a link. it is
// read at mount and on popstate, and written on every change: a destination
// pushes an entry, everything else replaces the one already there
export function useRoute(): { route: RouteState; go: Go } {
  const [route, setRoute] = useState<RouteState>(() => parseRoute(search()));
  // what the address bar is currently showing. without it a popstate would be
  // written straight back, and the first render could not tidy a junk link
  const shown = useRef(route);

  useEffect(() => {
    const onPop = () => {
      const next = parseRoute(search());
      shown.current = next;
      setRoute(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const from = shown.current;
    const next = writeParams(route, search());
    shown.current = route;
    if (next === search()) return;
    const url = `${window.location.pathname}${next}${window.location.hash}`;
    if (isNavigation(from, route)) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }, [route]);

  const go = useCallback<Go>((patch) => {
    setRoute((r) => ({ ...r, ...(typeof patch === "function" ? patch(r) : patch) }));
  }, []);

  return { route, go };
}

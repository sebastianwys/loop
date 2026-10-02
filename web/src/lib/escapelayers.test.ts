import { existsSync, readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailPanel } from "../components/DetailPanel";
import { Explainer } from "../components/Explainer";
import { MapPage } from "../components/MapPage";
import { Sidebar } from "../components/Sidebar";
import { DEFAULT_ROUTE, type RouteState } from "./route";
import type { Shell } from "./views";
import type { MapData } from "../types";

// there is no dom in this suite, so react's hooks are swapped for a runtime
// small enough to read: each mounted component keeps its hooks in a list, an
// effect runs after the render when its deps changed (after its last cleanup),
// and a setter leaves the component dirty until it is rendered again
const hooks = vi.hoisted(() => {
  interface Cell { slots: unknown[]; at: number; effects: (() => void)[]; dirty: boolean }
  const live: { cell: Cell | null } = { cell: null };
  const cell = (): Cell => {
    if (!live.cell) throw new Error("a hook ran outside a mounted component");
    return live.cell;
  };
  const changed = (a?: unknown[], b?: unknown[]) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));

  function useState(init: unknown) {
    const c = cell();
    const i = c.at++;
    if (!(i in c.slots)) {
      const box = { value: typeof init === "function" ? (init as () => unknown)() : init, set: (_next: unknown) => {} };
      box.set = (next) => {
        const value = typeof next === "function" ? (next as (v: unknown) => unknown)(box.value) : next;
        if (!Object.is(value, box.value)) {
          box.value = value;
          c.dirty = true;
        }
      };
      c.slots[i] = box;
    }
    const box = c.slots[i] as { value: unknown; set: (next: unknown) => void };
    return [box.value, box.set];
  }
  function useRef(value: unknown) {
    const c = cell();
    const i = c.at++;
    if (!(i in c.slots)) c.slots[i] = { current: value };
    return c.slots[i];
  }
  function useMemo(make: () => unknown, deps?: unknown[]) {
    const c = cell();
    const i = c.at++;
    const last = c.slots[i] as { deps?: unknown[]; value: unknown } | undefined;
    if (last && !changed(last.deps, deps)) return last.value;
    const value = make();
    c.slots[i] = { deps, value };
    return value;
  }
  const useCallback = (fn: unknown, deps?: unknown[]) => useMemo(() => fn, deps);
  function useEffect(effect: () => unknown, deps?: unknown[]) {
    const c = cell();
    const i = c.at++;
    const last = c.slots[i] as { deps?: unknown[]; cleanup?: unknown } | undefined;
    if (last && !changed(last.deps, deps)) return;
    const slot = { deps, cleanup: last?.cleanup };
    c.slots[i] = slot;
    c.effects.push(() => {
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.cleanup = effect();
    });
  }
  const useId = () => {
    cell().at++;
    return ":r0:";
  };

  // one component instance: render until nothing is dirty, effects after each
  function mount<P>(component: (props: P) => unknown, props: P) {
    const c: Cell = { slots: [], at: 0, effects: [], dirty: true };
    const self = {
      tree: null as unknown,
      render() {
        for (let n = 0; c.dirty; n += 1) {
          if (n > 50) throw new Error("render loop");
          c.dirty = false;
          c.at = 0;
          c.effects = [];
          live.cell = c;
          self.tree = component(props);
          live.cell = null;
          for (const run of c.effects) run();
        }
        return self.tree;
      },
    };
    self.render();
    return self;
  }

  return { useState, useRef, useMemo, useCallback, useEffect, useId, mount };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  const swapped = {
    useState: hooks.useState, useRef: hooks.useRef, useMemo: hooks.useMemo, useCallback: hooks.useCallback,
    useEffect: hooks.useEffect, useLayoutEffect: hooks.useEffect, useId: hooks.useId,
  };
  return { ...real, ...swapped, default: { ...real, ...swapped } };
});

// leaflet reads window at import. nothing about escape lives in the map
// itself, and no component here renders it, so the library is stubbed
vi.mock("leaflet", () => ({ canvas: () => ({}), latLng: (lat: number, lng: number) => ({ lat, lng }) }));
vi.mock("react-leaflet", () => ({
  MapContainer: () => null, TileLayer: () => null, CircleMarker: () => null, Tooltip: () => null, useMap: () => ({}),
}));

// a keydown the way a browser delivers it to listeners on document and window:
// the capture phase from window inward, then the bubble phase from document
// out to window. stopPropagation ends it after the current target, and
// stopImmediatePropagation at once
class KeyEvent {
  readonly type = "keydown";
  defaultPrevented = false;
  stopped = false;
  immediate = false;
  constructor(readonly key: string) {}
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.stopped = true; this.immediate = true; }
  get cancelBubble() { return this.stopped; }
}

type Listener = (e: KeyEvent) => void;
const captures = (options?: boolean | { capture?: boolean }) =>
  typeof options === "boolean" ? options : !!options?.capture;

class Target {
  private listeners: { type: string; listener: Listener; capture: boolean }[] = [];
  addEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }) {
    const capture = captures(options);
    if (!this.listeners.some((l) => l.type === type && l.listener === listener && l.capture === capture)) {
      this.listeners.push({ type, listener, capture });
    }
  }
  removeEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }) {
    const capture = captures(options);
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.listener === listener && l.capture === capture));
  }
  fire(e: KeyEvent, capture: boolean) {
    for (const l of this.listeners.filter((x) => x.type === e.type && x.capture === capture)) {
      l.listener(e);
      if (e.immediate) return;
    }
  }
}

function press(key: string, win: Target, doc: Target): KeyEvent {
  const e = new KeyEvent(key);
  for (const t of [win, doc]) {
    t.fire(e, true);
    if (e.stopped) return e;
  }
  for (const t of [doc, win]) {
    t.fire(e, false);
    if (e.stopped) return e;
  }
  return e;
}

type El = { type: unknown; props: Record<string, unknown> };
function* elements(node: unknown): Generator<El> {
  if (Array.isArray(node)) {
    for (const n of node) yield* elements(n);
    return;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return;
  const el = node as El;
  yield el;
  yield* elements(el.props.children);
}
const find = (tree: unknown, match: (el: El) => boolean): El => {
  const hit = [...elements(tree)].find(match);
  if (!hit) throw new Error("element not found");
  return hit;
};
const bubbleOpen = (tree: unknown) => [...elements(tree)].some((el) => el.props.role === "note");

// the built json is optional in ci, so this suite skips when it is absent
const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

afterEach(() => vi.unstubAllGlobals());

// the map page closes the open metro, or a drawer, on any escape that reaches
// window. a question mark bubble closes itself on escape from a listener on
// document, so it has to stop the event there or one press closes two layers.
// the rule the rest of the page keeps is NationalStrip's: "escape closes the
// detail row and stops there, so the map keeps its selection"
describe.skipIf(!present)("escape with a question mark bubble open", () => {
  function page(shellOpen: { drawer: boolean; open: boolean }, mode: "wide" | "phone") {
    const win = new Target();
    const doc = new Target();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    let route: RouteState = { ...DEFAULT_ROUTE, metro: "17410" };
    const calls: unknown[] = [];
    const drawer = { open: shellOpen.open };
    const shell: Shell = {
      drawer: shellOpen.drawer, open: shellOpen.open, condensed: false, width: null,
      setOpen: (open) => { drawer.open = open; }, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
    };
    const map = hooks.mount(MapPage, {
      data: data!,
      route,
      go: (patch) => {
        calls.push(patch);
        route = { ...route, ...(typeof patch === "function" ? patch(route) : patch) };
      },
      viewport: { width: mode === "wide" ? 1440 : 390, height: 900, mode, coarse: mode === "phone", reducedMotion: false },
      shell,
    });
    // a question mark as its parent draws it, opened by a click on its button
    const open = (parent: unknown, label: string) => {
      const help = find(parent, (el) => el.type === Explainer && el.props.label === label);
      const bubble = hooks.mount(Explainer, help.props as { label: string; children: ReactNode });
      (find(bubble.tree, (el) => el.type === "button").props.onClick as () => void)();
      bubble.render();
      expect(bubbleOpen(bubble.tree), "the bubble opened").toBe(true);
      return bubble;
    };
    return { map, win, doc, calls, drawer, open, route: () => route };
  }

  it("closes the forecasts bubble in cleveland's detail panel and leaves cleveland open", () => {
    const { map, win, doc, calls, open, route } = page({ drawer: false, open: true }, "wide");
    const detail = find(map.tree, (el) => el.type === DetailPanel);
    const panel = hooks.mount(DetailPanel, detail.props as unknown as Parameters<typeof DetailPanel>[0]);
    const bubble = open(panel.tree, "these forecasts");

    const e = press("Escape", win, doc);
    bubble.render();
    map.render();

    expect(bubbleOpen(bubble.tree), "the bubble is still open").toBe(false);
    expect(route().metro, `go received ${JSON.stringify(calls)}; the escape went on to window unstopped: ${!e.stopped}`)
      .toBe("17410");
  });

  it("closes the metric bubble in an open drawer and leaves the drawer open", () => {
    const { map, win, doc, drawer, open } = page({ drawer: true, open: true }, "phone");
    const side = find(map.tree, (el) => el.type === Sidebar);
    const sidebar = hooks.mount(Sidebar, side.props as unknown as Parameters<typeof Sidebar>[0]);
    const bubble = open(sidebar.tree, "this metric");

    const e = press("Escape", win, doc);
    bubble.render();

    expect(bubbleOpen(bubble.tree), "the bubble is still open").toBe(false);
    expect(drawer.open, `the escape went on to window unstopped: ${!e.stopped}`).toBe(true);
  });
});

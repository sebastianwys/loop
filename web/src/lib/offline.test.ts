import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { REPLACE_MS } from "./route";

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

// leaflet reads window at import. App reaches it through the map view, which
// is never drawn here, so the library is stubbed
vi.mock("leaflet", () => ({ canvas: () => ({}), latLng: (lat: number, lng: number) => ({ lat, lng }) }));
vi.mock("react-leaflet", () => ({
  MapContainer: () => null, TileLayer: () => null, CircleMarker: () => null, Tooltip: () => null, useMap: () => ({}),
}));

// the address bar and the history api, which is all of the browser App's
// route reads and writes. every write lands in location, as it does in a tab
function tab(search: string) {
  const location = { pathname: "/", search, hash: "" };
  const writes: string[] = [];
  const land = (url: string) => {
    writes.push(url);
    location.search = new URL(url, "https://loop.test").search;
  };
  const events = new EventTarget();
  vi.stubGlobal("window", {
    location,
    history: { pushState: (_s: unknown, _t: string, url: string) => land(url), replaceState: (_s: unknown, _t: string, url: string) => land(url) },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    innerWidth: 1440,
    innerHeight: 900,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  });
  return { location, writes };
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

// the metros any element on the page was handed to draw
function drawn(tree: unknown): string[] {
  return [...elements(tree)].flatMap((el) => {
    const data = el.props.data as { metros?: { cbsa: string; name: string }[] } | undefined;
    return Array.isArray(data?.metros) ? data.metros.map((m) => `${m.cbsa} ${m.name}`) : [];
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// a shared link to cleveland compared with baltimore
const LINK = "?metro=17410&compare=17410,12580";

// the page as it stands once a load that failed has settled, including any
// capped write to the address bar, which lands at most REPLACE_MS later
async function openAfterOneFailedLoad() {
  const browser = tab(LINK);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
  const app = hooks.mount(App, {});
  for (let i = 0; i < 5; i += 1) {
    await wait(0);
    app.render();
  }
  await wait(REPLACE_MS + 50);
  app.render();
  return { app, ...browser };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// data.ts falls back to the three metro sample only in dev. in the deployed
// build a single dropped request must not be answered with that fixture, or
// App would tidy the address bar against the fixture's codes as if it were
// this build, and the write is a replace
describe("a production page whose metros.json fails to load once", () => {
  it("keeps the shared link in the address bar, so reloading after the network recovers opens it", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("PROD", true);
    vi.stubEnv("MODE", "production");
    const { location, writes } = await openAfterOneFailedLoad();
    expect(location.search, `address bar writes: ${JSON.stringify(writes)}`).toBe(LINK);
  });

  it("does not draw the three metro test fixture as if it were the build", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("PROD", true);
    vi.stubEnv("MODE", "production");
    const { app } = await openAfterOneFailedLoad();
    expect(drawn(app.tree)).toEqual([]);
  });
});

// a red test. run it on purpose:
//   cd web && npx vitest run --config redtest.config.ts src/lib/shapetooltip.redtest.ts
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShapeLayer } from "../components/ShapeLayer";
import type { Shape } from "./boundaries";
import { defById, isInherited, resolveMetric } from "./metrics";
import { buildScale } from "./scale";
import type { MapData, Metro } from "../types";

// there is no dom here, so react's hooks are swapped for a runtime small
// enough to read: a mounted component keeps its hooks in a list and an effect
// runs after the render when its deps changed. the shape layer only needs
// refs and effects, and leaflet is a stub that keeps each path's tooltip
const hooks = vi.hoisted(() => {
  interface Cell { slots: unknown[]; at: number; effects: (() => void)[] }
  const live: { cell: Cell | null } = { cell: null };
  const cell = (): Cell => {
    if (!live.cell) throw new Error("a hook ran outside a mounted component");
    return live.cell;
  };
  const changed = (a?: unknown[], b?: unknown[]) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  function useRef(value: unknown) {
    const c = cell();
    const i = c.at++;
    if (!(i in c.slots)) c.slots[i] = { current: value };
    return c.slots[i];
  }
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
  function mount<P>(component: (props: P) => unknown, props: P) {
    const c: Cell = { slots: [], at: 0, effects: [] };
    live.cell = c;
    component(props);
    live.cell = null;
    for (const run of c.effects) run();
  }
  // every path leaflet was asked to draw, by the metro code in its feature id
  const paths = new Map<string, { tooltip: unknown }>();
  return { useRef, useEffect, mount, paths };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  const swapped = { useRef: hooks.useRef, useEffect: hooks.useEffect, useLayoutEffect: hooks.useEffect };
  return { ...real, ...swapped, default: { ...real, ...swapped } };
});

vi.mock("leaflet", () => ({
  geoJSON: (collection: { features: { id?: string }[] }, options: { onEachFeature?: (f: unknown, l: unknown) => void }) => {
    for (const feature of collection.features) {
      const path = {
        tooltip: null as unknown,
        bindTooltip(content: unknown) { path.tooltip = content; return path; },
        setTooltipContent(content: unknown) { path.tooltip = content; return path; },
        on() { return path; },
        setStyle() { return path; },
        bringToFront() { return path; },
      };
      hooks.paths.set(String(feature.id), path);
      options.onEachFeature?.(feature, path);
    }
    const layer = { addTo: () => layer, remove: () => {} };
    return layer;
  },
}));
vi.mock("react-leaflet", () => ({ useMap: () => ({}) }));

// just enough of a document for the tooltip ShapeLayer builds with textContent
class Text {
  constructor(public textContent: string) {}
}
class Element {
  className = "";
  children: (Element | Text)[] = [];
  private own = "";
  constructor(public tag: string) {}
  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this.own;
  }
  set textContent(value: string) {
    this.own = value;
    this.children = [];
  }
  append(...nodes: (Element | Text | string)[]) {
    for (const n of nodes) this.children.push(typeof n === "string" ? new Text(n) : n);
  }
  appendChild(n: Element | Text) {
    this.children.push(n);
    return n;
  }
}

afterEach(() => vi.unstubAllGlobals());

const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

// newark's zillow home value index is the new york metro's: zillow publishes
// metros only. the dots tooltip says so, "from New York-Newark-Jersey City,
// NY-NJ", and the shape drawn for the same number has to as well
describe.skipIf(!present)("a division's inherited value in shapes mode", () => {
  function tooltips(metros: Metro[]) {
    vi.stubGlobal("document", {
      createElement: (tag: string) => new Element(tag),
      createTextNode: (text: string) => new Text(text),
    });
    hooks.paths.clear();
    const metric = resolveMetric(defById("zhvi")!.def, "latest");
    const shapes = metros.map((metro) => ({
      metro,
      feature: { type: "Feature", geometry: null, properties: { GEOID: metro.cbsa, NAME: metro.name } },
    })) as unknown as Shape[];
    const scale = buildScale(data!.metros.map(metric.accessor), metric.kind);
    hooks.mount(ShapeLayer, { shapes, metric, scale, selectedCbsa: null, onSelect: () => {} });
    return { metric, text: (cbsa: string) => (hooks.paths.get(cbsa)?.tooltip as Element | undefined)?.textContent ?? null };
  }

  it("names the parent the number belongs to, as the dots tooltip does", () => {
    const newark = data!.metros.find((m) => m.cbsa === "35084")!;
    const cleveland = data!.metros.find((m) => m.cbsa === "17410")!;
    const { metric, text } = tooltips([newark, cleveland]);
    expect(isInherited(newark, metric)).toBe(true);
    expect(metric.accessor(newark)).not.toBeNull();
    expect(newark.parent?.name).toBe("New York-Newark-Jersey City, NY-NJ");

    expect(text("35084"), "no tooltip was bound for newark").not.toBeNull();
    expect(text("35084")).toContain(`from ${newark.parent!.name}`);
    // a metro's own number carries no parent
    expect(text("17410")).not.toContain("from ");
  });
});

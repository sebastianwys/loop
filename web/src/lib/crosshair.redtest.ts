// a red test. run it on purpose:
//   cd web && npx vitest run --config redtest.config.ts src/lib/crosshair.redtest.ts
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { HistoryChart } from "../components/HistoryChart";
import { forecastOf } from "./history";
import type { MapData } from "../types";

// no dom here, so react's hooks are swapped for a runtime small enough to
// read. one mounted component keeps its hooks in a list across renders, the
// way react keeps a component's state while its parent hands it new props:
// DetailPanel is not keyed by metro, so the chart in it is the same instance
// from one metro to the next
const hooks = vi.hoisted(() => {
  interface Cell { slots: unknown[]; at: number; dirty: boolean }
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
  // render until nothing is dirty, with the props the parent hands down now
  function mount<P>(component: (props: P) => unknown, first: P) {
    const c: Cell = { slots: [], at: 0, dirty: true };
    const self = {
      props: first,
      tree: null as unknown,
      render(next?: P) {
        if (next) {
          self.props = next;
          c.dirty = true;
        }
        for (let n = 0; c.dirty; n += 1) {
          if (n > 50) throw new Error("render loop");
          c.dirty = false;
          c.at = 0;
          live.cell = c;
          self.tree = component(self.props);
          live.cell = null;
        }
        return self.tree;
      },
    };
    self.render();
    return self;
  }
  return { useState, useRef, useMemo, mount };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  const swapped = { useState: hooks.useState, useRef: hooks.useRef, useMemo: hooks.useMemo };
  return { ...real, ...swapped, default: { ...real, ...swapped } };
});

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
// the words in the crosshair's tip, null when no tip is drawn
const tip = (tree: unknown): string | null => {
  const text = [...elements(tree)].find((el) => el.props.className === "tip-text");
  return text ? String(text.props.children) : null;
};

const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

describe.skipIf(!present)("the price chart's crosshair across a change of metro", () => {
  it("is cleared when the series changes, rather than reading the old metro over the new line", () => {
    const cleveland = data!.metros.find((m) => m.cbsa === "17410")!;
    const baltimore = data!.metros.find((m) => m.cbsa === "12580")!;
    expect(cleveland.series!.hpi!.start).toBe(1976);
    expect(baltimore.series!.hpi!.start).toBe(1977);

    const props = (metro: typeof cleveland) => ({ series: metro.series!.hpi!, forecast: forecastOf(metro), name: metro.name });
    const chart = hooks.mount(HistoryChart as (p: ReturnType<typeof props>) => unknown, props(cleveland));
    // the chart has focus and the reader steps once with the right arrow
    const svg = [...elements(chart.tree)].find((el) => el.type === "svg")!;
    (svg.props.onKeyDown as (e: unknown) => void)({ key: "ArrowRight", preventDefault: () => {} });
    chart.render();
    expect(tip(chart.tree)).toMatch(/^1976: /);

    // the route moves to baltimore with no blur and no mouseleave, as a back
    // or forward from the keyboard does
    chart.render(props(baltimore));
    expect(tip(chart.tree), "the tip still reads cleveland's year over baltimore's line").toBeNull();
  });
});

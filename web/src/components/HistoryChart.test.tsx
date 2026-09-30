import { describe, expect, it, vi } from "vitest";
import { SAMPLE } from "../lib/data";
import type { AnnualSeries } from "../types";
import { HistoryChart } from "./HistoryChart";

// no dom in this suite, and the crosshair is state, so react's hooks are
// swapped for a runtime small enough to read: one mounted component keeps its
// hooks across renders, the way react keeps a chart's state while the panel
// around it hands it the next metro's series
const hooks = vi.hoisted(() => {
  interface Cell { slots: unknown[]; at: number; dirty: boolean }
  const live: { cell: Cell | null } = { cell: null };
  const cell = (): Cell => {
    if (!live.cell) throw new Error("a hook ran outside a mounted component");
    return live.cell;
  };
  function useState(init: unknown) {
    const c = cell();
    const i = c.at++;
    if (!(i in c.slots)) {
      const box = { value: init, set: (_next: unknown) => {} };
      box.set = (next) => {
        if (!Object.is(next, box.value)) {
          box.value = next;
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
  function useMemo(make: () => unknown, deps: unknown[]) {
    const c = cell();
    const i = c.at++;
    const last = c.slots[i] as { deps: unknown[]; value: unknown } | undefined;
    if (last && deps.every((d, k) => Object.is(d, last.deps[k]))) return last.value;
    c.slots[i] = { deps, value: make() };
    return (c.slots[i] as { value: unknown }).value;
  }
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
  yield node as El;
  yield* elements((node as El).props.children);
}
const tip = (tree: unknown) => [...elements(tree)].find((el) => el.props.className === "tip-text")?.props.children ?? null;

describe("the price chart's crosshair", () => {
  const one = SAMPLE.metros[0].series!.hpi!;
  const next: AnnualSeries = { ...one, start: one.start + 1, values: one.values.map((v) => (v === null ? null : v + 40)) };
  type Props = { series: AnnualSeries; forecast: null; name: string };

  // a back or forward from the keyboard moves the panel to the next metro
  // with no blur and no mouseleave, so the chart has to drop the readout
  it("is cleared when the series changes rather than reading the last metro over the new line", () => {
    const chart = hooks.mount(HistoryChart as (p: Props) => unknown, { series: one, forecast: null, name: "Abilene, TX" });
    const svg = [...elements(chart.tree)].find((el) => el.type === "svg")!;
    (svg.props.onKeyDown as (e: unknown) => void)({ key: "ArrowRight", preventDefault: () => {} });
    chart.render();
    expect(tip(chart.tree)).toBe(`${one.start}: ${one.values[0]!.toFixed(1)}`);

    chart.render({ series: next, forecast: null, name: "Somewhere else" });
    expect(tip(chart.tree)).toBeNull();
    // and the same series again keeps what the reader pointed at
    const again = [...elements(chart.tree)].find((el) => el.type === "svg")!;
    (again.props.onKeyDown as (e: unknown) => void)({ key: "ArrowRight", preventDefault: () => {} });
    chart.render({ series: next, forecast: null, name: "Somewhere else" });
    expect(tip(chart.tree)).toBe(`${next.start}: ${next.values[0]!.toFixed(1)}`);
  });
});

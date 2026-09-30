import { afterEach, describe, expect, it, vi } from "vitest";
import { Explainer } from "../components/Explainer";

// no dom in this suite, and the bubble's escape is an effect, so react's hooks
// are swapped for a runtime small enough to read: a mounted component keeps
// its hooks in a list, an effect runs after the render when its deps changed
// (after its last cleanup), and a setter leaves the component dirty until it
// is rendered again
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
      const box = { value: init, set: (_next: unknown) => {} };
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
  return { useState, useRef, useEffect, useId, mount };
});

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  const swapped = { useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect, useId: hooks.useId };
  return { ...real, ...swapped, default: { ...real, ...swapped } };
});

// a keydown the way a browser delivers it to listeners on window and document:
// the capture phase from window inward, then the bubble phase from document
// out to window. stopPropagation ends it after the current target
class KeyEvent {
  readonly type = "keydown";
  stopped = false;
  constructor(readonly key: string) {}
  stopPropagation() { this.stopped = true; }
  preventDefault() {}
}

type Listener = (e: KeyEvent) => void;

class Target {
  private listeners: { type: string; listener: Listener; capture: boolean }[] = [];
  addEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    this.listeners.push({ type, listener, capture });
  }
  removeEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.listener === listener && l.capture === capture));
  }
  fire(e: KeyEvent, capture: boolean) {
    for (const l of this.listeners.filter((x) => x.type === e.type && x.capture === capture)) l.listener(e);
  }
}

function press(key: string, win: Target, doc: Target): KeyEvent {
  const e = new KeyEvent(key);
  for (const [target, capture] of [[win, true], [doc, true], [doc, false], [win, false]] as const) {
    target.fire(e, capture);
    if (e.stopped) break;
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
  yield node as El;
  yield* elements((node as El).props.children);
}
const bubbleOpen = (tree: unknown) => [...elements(tree)].some((el) => el.props.role === "note");

afterEach(() => vi.unstubAllGlobals());

// the map listens for escape on window, and closes the open metro or the
// drawer when one reaches it. a question mark bubble sits inside both, so its
// escape closes the bubble and stops there, or one press closes two layers
describe("escape with a question mark bubble open", () => {
  function setup() {
    const win = new Target();
    const doc = new Target();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    const reached: string[] = [];
    win.addEventListener("keydown", (e) => {
      if (e.key === "Escape") reached.push("the map closed the metro");
    });
    const bubble = hooks.mount(Explainer, { label: "these forecasts", children: "a sentence" });
    return { win, doc, reached, bubble };
  }

  it("closes the bubble and stops there, so the map keeps the metro open", () => {
    const { win, doc, reached, bubble } = setup();
    const button = [...elements(bubble.tree)].find((el) => el.type === "button")!;
    (button.props.onClick as () => void)();
    bubble.render();
    expect(bubbleOpen(bubble.tree)).toBe(true);

    const e = press("Escape", win, doc);
    bubble.render();
    expect(bubbleOpen(bubble.tree)).toBe(false);
    expect(e.stopped).toBe(true);
    expect(reached).toEqual([]);
  });

  // the control: with no bubble open, escape is the map's to act on
  it("leaves an escape with no bubble open to the map", () => {
    const { win, doc, reached, bubble } = setup();
    expect(bubbleOpen(bubble.tree)).toBe(false);
    press("Escape", win, doc);
    expect(reached).toEqual(["the map closed the metro"]);
  });
});

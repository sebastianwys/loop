import { useEffect, useState } from "react";

// four shapes the page takes. the names say what the sidebar does, since
// that is the thing that moves: docked beside the map, or a drawer over it
export type LayoutMode = "phone" | "tablet" | "compact" | "wide";

// css px, matched one for one by the media queries in styles.css. a windows
// laptop at 150% scaling reports 1280, which is why compact starts below it
export const BREAKPOINTS = { tablet: 640, compact: 900, wide: 1400 } as const;

export function layoutFor(width: number): LayoutMode {
  if (!Number.isFinite(width) || width <= 0) return "wide";
  if (width < BREAKPOINTS.tablet) return "phone";
  if (width < BREAKPOINTS.compact) return "tablet";
  if (width < BREAKPOINTS.wide) return "compact";
  return "wide";
}

// below compact the sidebar floats over the map, so it has to be dismissed
export function sidebarIsDrawer(mode: LayoutMode): boolean {
  return mode === "phone" || mode === "tablet";
}

// a drawer starts shut so the map is the first thing you see on a phone
export function sidebarStartsOpen(mode: LayoutMode): boolean {
  return !sidebarIsDrawer(mode);
}

// the legend covers a phone map, so it starts rolled up there
export function legendStartsOpen(mode: LayoutMode): boolean {
  return mode !== "phone";
}

// picking a metro on a phone should get the drawer out of the way. on a
// docked sidebar it would be wrong to close what the click came from
export function closesOnSelect(mode: LayoutMode): boolean {
  return sidebarIsDrawer(mode);
}

// the docked sidebar can be dragged narrower by the grip on its inner edge.
// css px, to match the grid column the drag writes. condense is the width the
// panel gives up its roomy form at, which is a little under the 15rem the
// stylesheet starts from
export const SIDEBAR = { min: 176, max: 520, condense: 248, step: 16, page: 64 } as const;

// a drag can never take more than half the window, or the map it is there to
// read stops being a map. a narrow window lowers the ceiling before the floor
export function sidebarBounds(viewportWidth: number): { min: number; max: number } {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return { min: SIDEBAR.min, max: SIDEBAR.max };
  const max = Math.min(SIDEBAR.max, Math.round(viewportWidth / 2));
  return { min: Math.min(SIDEBAR.min, max), max };
}

export function clampSidebarWidth(width: number, viewportWidth: number): number {
  const { min, max } = sidebarBounds(viewportWidth);
  if (!Number.isFinite(width)) return min;
  return Math.round(Math.min(max, Math.max(min, width)));
}

// under this the sidebar wears its short form: tighter padding, no source
// line, and headings that say the short thing
export function sidebarIsCondensed(width: number | null): boolean {
  return width !== null && Number.isFinite(width) && width < SIDEBAR.condense;
}

// the keyboard half of the grip. a separator is expected to answer the arrows,
// and home and end take it to the stops. null means the key was not ours
export function sidebarWidthForKey(key: string, width: number, viewportWidth: number): number | null {
  const { min, max } = sidebarBounds(viewportWidth);
  const to = (next: number) => clampSidebarWidth(next, viewportWidth);
  switch (key) {
    case "ArrowLeft": return to(width - SIDEBAR.step);
    case "ArrowRight": return to(width + SIDEBAR.step);
    case "PageDown": return to(width - SIDEBAR.page);
    case "PageUp": return to(width + SIDEBAR.page);
    case "Home": return min;
    case "End": return max;
    default: return null;
  }
}

export interface ScrollEdges {
  left: boolean;
  right: boolean;
}

// which way a sideways scroller can still move. the 2px slack keeps the
// arrow from flickering on the fractional scrollLeft a trackpad leaves
export function scrollEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): ScrollEdges {
  const max = scrollWidth - clientWidth;
  if (!Number.isFinite(max) || max <= 2) return { left: false, right: false };
  return { left: scrollLeft > 2, right: scrollLeft < max - 2 };
}

// a width the reader dragged outlives the tab. null means it was never
// dragged, and the stylesheet's own fluid width stands
const WIDTH_KEY = "loop.sidebar-width";

export interface WidthStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function localStore(): WidthStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // safari throws on localStorage in a blocked third party frame
    return null;
  }
}

export function readSidebarWidth(store: WidthStore | null = localStore()): number | null {
  try {
    const raw = store?.getItem(WIDTH_KEY);
    const width = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

export function writeSidebarWidth(width: number | null, store: WidthStore | null = localStore()): void {
  try {
    if (width === null) store?.removeItem(WIDTH_KEY);
    else store?.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // a full or disabled store is not a reason to stop resizing
  }
}

export interface Viewport {
  width: number;
  height: number;
  mode: LayoutMode;
  coarse: boolean;
  reducedMotion: boolean;
}

const SSR: Viewport = { width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false };

export function readViewport(): Viewport {
  if (typeof window === "undefined") return SSR;
  const width = window.innerWidth;
  const match = (q: string) => (typeof window.matchMedia === "function" ? window.matchMedia(q).matches : false);
  return {
    width,
    height: window.innerHeight,
    mode: layoutFor(width),
    coarse: match("(pointer: coarse)"),
    reducedMotion: match("(prefers-reduced-motion: reduce)"),
  };
}

// one resize listener for the whole app. rotating a phone fires resize, and
// so does a windows window snapped to half the screen
export function useViewport(): Viewport {
  const [viewport, setViewport] = useState<Viewport>(readViewport);

  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setViewport(readViewport()));
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  return viewport;
}

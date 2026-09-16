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

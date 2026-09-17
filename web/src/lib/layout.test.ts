import { describe, expect, it } from "vitest";
import {
  BREAKPOINTS, SIDEBAR, clampSidebarWidth, closesOnSelect, layoutFor, legendStartsOpen, readSidebarWidth,
  scrollEdges, sidebarBounds, sidebarIsCondensed, sidebarIsDrawer, sidebarStartsOpen, sidebarWidthForKey,
  writeSidebarWidth, type WidthStore,
} from "./layout";

describe("layoutFor", () => {
  it("names each band", () => {
    expect(layoutFor(390)).toBe("phone");
    expect(layoutFor(768)).toBe("tablet");
    expect(layoutFor(1280)).toBe("compact");
    expect(layoutFor(1728)).toBe("wide");
  });

  it("puts each breakpoint in the wider band", () => {
    expect(layoutFor(BREAKPOINTS.tablet - 1)).toBe("phone");
    expect(layoutFor(BREAKPOINTS.tablet)).toBe("tablet");
    expect(layoutFor(BREAKPOINTS.compact - 1)).toBe("tablet");
    expect(layoutFor(BREAKPOINTS.compact)).toBe("compact");
    expect(layoutFor(BREAKPOINTS.wide - 1)).toBe("compact");
    expect(layoutFor(BREAKPOINTS.wide)).toBe("wide");
  });

  // the sizes of the devices the map is checked on. windows reports css px,
  // so a 1920 panel at 150% scaling is a 1280 viewport
  it("reads the real devices", () => {
    expect(layoutFor(1728)).toBe("wide"); // macbook pro 16
    expect(layoutFor(1470)).toBe("wide"); // macbook air 13
    expect(layoutFor(1920)).toBe("wide"); // windows 1080p at 100%
    expect(layoutFor(1536)).toBe("wide"); // windows 1080p at 125%
    expect(layoutFor(1280)).toBe("compact"); // windows 1080p at 150%
    expect(layoutFor(1128)).toBe("compact"); // surface at 200%
    expect(layoutFor(820)).toBe("tablet"); // ipad portrait
    expect(layoutFor(393)).toBe("phone"); // iphone 15 pro
  });

  it("falls back to wide on a width it cannot read", () => {
    expect(layoutFor(0)).toBe("wide");
    expect(layoutFor(Number.NaN)).toBe("wide");
    expect(layoutFor(-100)).toBe("wide");
  });
});

describe("sidebar rules", () => {
  it("floats the sidebar below compact", () => {
    expect(sidebarIsDrawer("phone")).toBe(true);
    expect(sidebarIsDrawer("tablet")).toBe(true);
    expect(sidebarIsDrawer("compact")).toBe(false);
    expect(sidebarIsDrawer("wide")).toBe(false);
  });

  it("opens a docked sidebar and shuts a drawer", () => {
    expect(sidebarStartsOpen("wide")).toBe(true);
    expect(sidebarStartsOpen("compact")).toBe(true);
    expect(sidebarStartsOpen("tablet")).toBe(false);
    expect(sidebarStartsOpen("phone")).toBe(false);
  });

  it("closes a drawer when a metro is picked, never a docked one", () => {
    expect(closesOnSelect("phone")).toBe(true);
    expect(closesOnSelect("tablet")).toBe(true);
    expect(closesOnSelect("compact")).toBe(false);
    expect(closesOnSelect("wide")).toBe(false);
  });

  it("rolls the legend up on a phone only", () => {
    expect(legendStartsOpen("phone")).toBe(false);
    expect(legendStartsOpen("tablet")).toBe(true);
    expect(legendStartsOpen("wide")).toBe(true);
  });
});

describe("scrollEdges", () => {
  it("says neither way when the row fits", () => {
    expect(scrollEdges(0, 800, 800)).toEqual({ left: false, right: false });
    expect(scrollEdges(0, 801, 800)).toEqual({ left: false, right: false });
  });

  it("says right at the start of a long row", () => {
    expect(scrollEdges(0, 2400, 900)).toEqual({ left: false, right: true });
  });

  it("says both in the middle", () => {
    expect(scrollEdges(700, 2400, 900)).toEqual({ left: true, right: true });
  });

  it("says left at the end", () => {
    expect(scrollEdges(1500, 2400, 900)).toEqual({ left: true, right: false });
  });

  // a trackpad leaves a fractional scrollLeft, which flickered the arrow
  it("holds still inside the slack", () => {
    expect(scrollEdges(1.4, 2400, 900)).toEqual({ left: false, right: true });
    expect(scrollEdges(1499.2, 2400, 900)).toEqual({ left: true, right: false });
  });

  it("survives a row that has not been measured", () => {
    expect(scrollEdges(0, 0, 0)).toEqual({ left: false, right: false });
    expect(scrollEdges(0, Number.NaN, 900)).toEqual({ left: false, right: false });
  });
});

describe("the sidebar grip", () => {
  const wide = 1600;

  it("holds the drag between its stops", () => {
    expect(clampSidebarWidth(300, wide)).toBe(300);
    expect(clampSidebarWidth(40, wide)).toBe(SIDEBAR.min);
    expect(clampSidebarWidth(9000, wide)).toBe(SIDEBAR.max);
  });

  // the panel exists to read the map, so it can never own half of it
  it("lowers the ceiling on a narrow window", () => {
    expect(sidebarBounds(900)).toEqual({ min: SIDEBAR.min, max: 450 });
    expect(clampSidebarWidth(SIDEBAR.max, 900)).toBe(450);
    expect(sidebarBounds(wide).max).toBe(SIDEBAR.max);
  });

  // a window narrower than twice the floor would otherwise invert the stops
  it("keeps the floor under the ceiling in a tiny window", () => {
    const bounds = sidebarBounds(300);
    expect(bounds.max).toBe(150);
    expect(bounds.min).toBeLessThanOrEqual(bounds.max);
    expect(clampSidebarWidth(400, 300)).toBe(150);
  });

  it("falls back to the floor when the width is not a number", () => {
    expect(clampSidebarWidth(Number.NaN, wide)).toBe(SIDEBAR.min);
    expect(sidebarBounds(Number.NaN)).toEqual({ min: SIDEBAR.min, max: SIDEBAR.max });
  });

  it("condenses only below the threshold, and never before a drag", () => {
    expect(sidebarIsCondensed(SIDEBAR.condense - 1)).toBe(true);
    expect(sidebarIsCondensed(SIDEBAR.condense)).toBe(false);
    expect(sidebarIsCondensed(360)).toBe(false);
    expect(sidebarIsCondensed(null)).toBe(false);
  });

  it("answers the arrows, the pages and the stops, and nothing else", () => {
    expect(sidebarWidthForKey("ArrowLeft", 300, wide)).toBe(300 - SIDEBAR.step);
    expect(sidebarWidthForKey("ArrowRight", 300, wide)).toBe(300 + SIDEBAR.step);
    expect(sidebarWidthForKey("PageDown", 300, wide)).toBe(300 - SIDEBAR.page);
    expect(sidebarWidthForKey("PageUp", 300, wide)).toBe(300 + SIDEBAR.page);
    expect(sidebarWidthForKey("Home", 300, wide)).toBe(SIDEBAR.min);
    expect(sidebarWidthForKey("End", 300, wide)).toBe(SIDEBAR.max);
    expect(sidebarWidthForKey("Enter", 300, wide)).toBeNull();
    expect(sidebarWidthForKey("a", 300, wide)).toBeNull();
  });

  it("stops at the ends rather than walking past them", () => {
    expect(sidebarWidthForKey("ArrowLeft", SIDEBAR.min, wide)).toBe(SIDEBAR.min);
    expect(sidebarWidthForKey("ArrowRight", SIDEBAR.max, wide)).toBe(SIDEBAR.max);
  });
});

describe("the stored width", () => {
  const store = (value: string | null): WidthStore & { written: string | null } => {
    let held = value;
    return {
      get written() { return held; },
      getItem: () => held,
      setItem: (_k: string, v: string) => { held = v; },
      removeItem: () => { held = null; },
    };
  };

  it("reads a width back and rounds what it writes", () => {
    const s = store(null);
    writeSidebarWidth(287.6, s);
    expect(s.written).toBe("288");
    expect(readSidebarWidth(s)).toBe(288);
  });

  it("clears the width when the grip is reset", () => {
    const s = store("300");
    writeSidebarWidth(null, s);
    expect(readSidebarWidth(s)).toBeNull();
  });

  it("treats junk, zero and an absent store as never dragged", () => {
    expect(readSidebarWidth(store("wide"))).toBeNull();
    expect(readSidebarWidth(store("0"))).toBeNull();
    expect(readSidebarWidth(store(null))).toBeNull();
    expect(readSidebarWidth(null)).toBeNull();
  });

  // safari throws on storage in a blocked frame, which is not a reason to
  // stop the app from rendering
  it("survives a store that throws", () => {
    const hostile: WidthStore = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(readSidebarWidth(hostile)).toBeNull();
    expect(() => writeSidebarWidth(300, hostile)).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  BREAKPOINTS, closesOnSelect, layoutFor, legendStartsOpen, scrollEdges, sidebarIsDrawer, sidebarStartsOpen,
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

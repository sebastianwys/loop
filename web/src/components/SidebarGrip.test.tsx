import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SIDEBAR } from "../lib/layout";
import { SidebarGrip } from "./SidebarGrip";

// no dom in this suite, so the markup is read as a string: it proves the aria
// wiring a screen reader and a keyboard need, not the dragging
const grip = (width: number | null, viewportWidth = 1600, measured = 320) =>
  renderToStaticMarkup(
    <SidebarGrip
      width={width}
      viewportWidth={viewportWidth}
      measure={() => measured}
      onResize={() => {}}
      onReset={() => {}}
    />,
  );

describe("the sidebar grip", () => {
  it("is a focusable vertical separator that names what it resizes", () => {
    const markup = grip(300);
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-controls="controls"');
    expect(markup).toContain('aria-label="resize the controls"');
  });

  it("reports the width it is at, and the stops it can reach", () => {
    const markup = grip(300);
    expect(markup).toContain('aria-valuenow="300"');
    expect(markup).toContain(`aria-valuemin="${SIDEBAR.min}"`);
    expect(markup).toContain(`aria-valuemax="${SIDEBAR.max}"`);
  });

  // before the first drag there is no width in state, only the one the
  // stylesheet worked out, so the grip measures the panel instead
  it("measures the panel when no width has been chosen yet", () => {
    expect(grip(null, 1600, 336)).toContain('aria-valuenow="336"');
  });

  it("reports the narrower ceiling a small window imposes", () => {
    expect(grip(300, 900)).toContain('aria-valuemax="450"');
  });
});

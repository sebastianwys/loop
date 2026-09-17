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
      onCommit={() => {}}
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
  // stylesheet worked out. the grip measures the panel for that, but in a
  // layout effect rather than during the render: measuring while rendering
  // reads the dom as it was before this render was committed, which on the
  // first render is a dom the sidebar is not in yet. this suite renders to a
  // string, so no effect runs and no dom exists, and the honest markup is a
  // separator with no value yet. in a browser the effect fills it before paint
  it("reports no value until the panel has been measured", () => {
    const markup = grip(null, 1600, 336);
    expect(markup).not.toContain("aria-valuenow");
    expect(markup).not.toContain("aria-valuetext");
    expect(markup).toContain('role="separator"');
  });

  it("states the unit, so the number is not read as a percentage", () => {
    expect(grip(300)).toContain('aria-valuetext="300 pixels"');
  });

  it("reports the narrower ceiling a small window imposes", () => {
    expect(grip(300, 900)).toContain('aria-valuemax="450"');
  });
});

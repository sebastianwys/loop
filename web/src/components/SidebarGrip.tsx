import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SIDEBAR, clampSidebarWidth, sidebarBounds, sidebarWidthForKey } from "../lib/layout";

// the app is client only, but the component tests render it to a string,
// where a layout effect cannot run and react says so loudly. nothing visual
// depends on this effect, only the value the grip reports, so the plain
// effect is a fair stand in where there is no dom
const useMeasureEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface Props {
  // the width now, or null while the stylesheet's fluid width still stands
  width: number | null;
  viewportWidth: number;
  measure: () => number;
  // during a drag: the width changes but nothing is written down
  onResize: (width: number) => void;
  // the end of a gesture: this is the width to remember
  onCommit: (width: number) => void;
  onReset: () => void;
}

// the drag handle on the sidebar's inner edge. aria calls this a window
// splitter: a separator that takes focus and answers the arrow keys, so the
// panel can be narrowed without a pointer. double click puts it back
export function SidebarGrip({ width, viewportWidth, measure, onResize, onCommit, onReset }: Props) {
  const dragging = useRef(false);
  const { min, max } = sidebarBounds(viewportWidth);
  // measuring during render reads the dom as it was before this render was
  // committed: on the first one the sidebar does not exist yet, and after a
  // reset the inline width react is about to remove is still there. either
  // way the grip would report a width the panel does not have, and the first
  // arrow key would jump the panel to it. a layout effect runs after the
  // commit and before paint, so this is the width on screen
  const [measured, setMeasured] = useState<number | null>(null);
  useMeasureEffect(() => {
    setMeasured(width === null ? measure() : null);
  }, [width, measure, viewportWidth]);
  const now = width ?? measured;

  const originOf = (e: React.PointerEvent<HTMLDivElement>) =>
    e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;

  const widthAt = (clientX: number, origin: number) => clampSidebarWidth(clientX - origin, viewportWidth);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // a right click is not a drag. touch reports button 0 as well, so this
    // does not filter a second finger, which stop() handles by pointer id
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    // no resize here. a click that never moves should leave the fluid width
    // alone rather than pinning the panel to whatever pixel was under it
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    // the button was released somewhere this element never heard about, so
    // the drag is over and the panel must not follow a bare hover
    if (e.buttons === 0) {
      stop(e);
      return;
    }
    onResize(widthAt(e.clientX, originOf(e)));
  };

  const stop = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit(widthAt(e.clientX, originOf(e)));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // alt and left is the browser's back, and the rest belong to the page
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const from = now ?? measure();
    const next = sidebarWidthForKey(e.key, from, viewportWidth);
    if (next === null) return;
    e.preventDefault();
    onCommit(next);
  };

  return (
    <div
      className="sidebar-grip"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="resize the controls"
      aria-valuenow={now === null ? undefined : Math.round(now)}
      aria-valuetext={now === null ? undefined : `${Math.round(now)} pixels`}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-controls="controls"
      title={`Drag to resize. Double click to reset. Under ${SIDEBAR.condense}px the panel condenses.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    >
      <span className="bar" aria-hidden="true" />
    </div>
  );
}

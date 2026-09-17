import { useRef } from "react";
import { SIDEBAR, clampSidebarWidth, sidebarBounds, sidebarWidthForKey } from "../lib/layout";

interface Props {
  // the width now, or null while the stylesheet's fluid width still stands.
  // the grip measures the panel on first use, so null still drags
  width: number | null;
  viewportWidth: number;
  measure: () => number;
  onResize: (width: number) => void;
  onReset: () => void;
}

// the drag handle on the sidebar's inner edge. aria calls this a window
// splitter: a separator that takes focus and answers the arrow keys, so the
// panel can be narrowed without a pointer. double click puts it back
export function SidebarGrip({ width, viewportWidth, measure, onResize, onReset }: Props) {
  const dragging = useRef(false);
  const { min, max } = sidebarBounds(viewportWidth);
  const now = width ?? measure();

  const moveTo = (clientX: number, origin: number) => {
    onResize(clampSidebarWidth(clientX - origin, viewportWidth));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // a second finger or a right click is not a drag
    if (e.button !== 0) return;
    const origin = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    moveTo(e.clientX, origin);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const origin = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    moveTo(e.clientX, origin);
  };

  const stop = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const next = sidebarWidthForKey(e.key, now, viewportWidth);
    if (next === null) return;
    e.preventDefault();
    onResize(next);
  };

  return (
    <div
      className="sidebar-grip"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="resize the controls"
      aria-valuenow={Math.round(now)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-controls="controls"
      title={`Drag to resize. Double click to reset. Under ${SIDEBAR.condense}px the panel condenses.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    >
      <span className="bar" aria-hidden="true" />
    </div>
  );
}

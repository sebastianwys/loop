import { useMemo, useRef, useState } from "react";
import { exploreTitle, nearestPoint, type ExploreModel, type ExplorePoint } from "../lib/explore";
import { formatValue } from "../lib/format";
import type { Metric } from "../lib/metrics";

interface Props {
  model: ExploreModel;
  x: Metric;
  y: Metric;
  selected: string | null;
  onPick: (cbsa: string) => void;
}

// ten dots at a time, so a reader on the keyboard can cross 410 of them
// without holding an arrow key down for a minute
const LEAP = 10;

export function ExploreChart({ model, x, y, selected, onPick }: Props) {
  const [cursor, setCursor] = useState<ExplorePoint | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const title = useMemo(() => exploreTitle(model, x.label, y.label), [model, x.label, y.label]);

  const xv = (v: number) => formatValue(v, x.format, x.kind === "diverging");
  const yv = (v: number) => formatValue(v, y.format, y.kind === "diverging");

  const spot = model.points.find((p) => p.cbsa === selected) ?? null;
  // the keyboard cursor outranks the pointer, and both outrank the selection
  const read = cursor ?? spot;

  const local = (e: { clientX: number; clientY: number }) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return null;
    return {
      px: ((e.clientX - box.left) * model.width) / box.width,
      py: ((e.clientY - box.top) * model.height) / box.height,
    };
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const at = local(e);
    if (at) setCursor(nearestPoint(model, at.px, at.py));
  };

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const at = local(e);
    const hit = at ? nearestPoint(model, at.px, at.py) : null;
    if (hit) onPick(hit.cbsa);
  };

  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    const points = model.points;
    if (points.length === 0) return;
    if (e.key === "Enter" || e.key === " ") {
      if (!read) return;
      e.preventDefault();
      onPick(read.cbsa);
      return;
    }
    const at = read === null ? -1 : points.findIndex((p) => p.cbsa === read.cbsa);
    const step: Record<string, number> = {
      ArrowRight: at + 1, ArrowLeft: at < 0 ? points.length - 1 : at - 1,
      ArrowUp: at < 0 ? 0 : at + LEAP, ArrowDown: at < 0 ? points.length - 1 : at - LEAP,
      Home: 0, End: points.length - 1,
    };
    // hasOwn, not in: every object literal answers "constructor" as its own
    if (!Object.hasOwn(step, e.key)) return;
    e.preventDefault();
    setCursor(points[Math.min(points.length - 1, Math.max(0, step[e.key]))]);
  };

  // a narrow plot cannot carry every tick label without them touching
  const thin = model.width < 420 && model.x.ticks.length > 5;

  return (
    <div className="explore-plot">
      <svg
        ref={svg}
        className="explore-chart"
        width={model.width}
        height={model.height}
        viewBox={`0 0 ${model.width} ${model.height}`}
        role="img"
        aria-label={title}
        tabIndex={0}
        onMouseMove={onMove}
        onMouseLeave={() => setCursor(null)}
        onBlur={() => setCursor(null)}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <title>{title}</title>
        <rect className="field" x={model.left} y={model.top} width={model.right - model.left} height={model.bottom - model.top} />
        {model.y.ticks.map((t) => (
          <g key={`y${t.value}`}>
            <line className="grid" x1={model.left} x2={model.right} y1={t.pos} y2={t.pos} />
            <text className="lbl" x={model.left - 6} y={t.pos + 3} textAnchor="end">{yv(t.value)}</text>
          </g>
        ))}
        {model.x.ticks.map((t, i) => (
          <g key={`x${t.value}`}>
            <line className="grid" x1={t.pos} x2={t.pos} y1={model.top} y2={model.bottom} />
            {(!thin || i % 2 === 0) && (
              <text className="lbl" x={t.pos} y={model.height - 10} textAnchor="middle">{xv(t.value)}</text>
            )}
          </g>
        ))}
        {model.fit && model.fit.d && <path className="fit" d={model.fit.d} />}
        {model.points.map((p) => (
          p.inherited ? null : <circle key={p.cbsa} className="dot" cx={p.cx} cy={p.cy} r={model.radius} />
        ))}
        {model.points.map((p) => (
          p.inherited ? <circle key={p.cbsa} className="dot taken" cx={p.cx} cy={p.cy} r={model.radius + 0.4} /> : null
        ))}
        {spot && (
          <g className="spot" aria-hidden="true">
            <line className="guide" x1={model.left} x2={spot.cx} y1={spot.cy} y2={spot.cy} />
            <line className="guide" x1={spot.cx} x2={spot.cx} y1={spot.cy} y2={model.bottom} />
            <circle className="core" cx={spot.cx} cy={spot.cy} r={model.radius + 1.6} />
            <circle className="ring" cx={spot.cx} cy={spot.cy} r={model.radius + 5} />
          </g>
        )}
        {read && (
          <g className="cursor" aria-hidden="true">
            <circle className="halo" cx={read.cx} cy={read.cy} r={model.radius + 8} />
            <text
              className="tag"
              x={read.cx}
              y={read.cy - model.radius - 12}
              textAnchor={read.cx > model.right - 70 ? "end" : read.cx < model.left + 70 ? "start" : "middle"}
            >
              {read.short}
            </text>
          </g>
        )}
      </svg>
      <p className="explore-readout" aria-live="polite">
        {read === null ? (
          <span className="hint">point at a dot, or give the plot focus and use the arrow keys, to name a metro. enter opens it.</span>
        ) : (
          <>
            <span className="who">{read.name}</span>
            <span className="read">{x.label}<span className="v">{xv(read.x)}</span></span>
            <span className="read">{y.label}<span className="v">{yv(read.y)}</span></span>
            {read.inherited && <span className="note">one of these two is the parent metro's number</span>}
            {read.cbsa === selected && <span className="note">this one is open</span>}
          </>
        )}
      </p>
    </div>
  );
}

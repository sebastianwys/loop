import { useMemo, useRef, useState } from "react";
import { formatValue } from "../lib/format";
import { buildHistory, hoverables, nearestPoint, type ForecastInput, type Hovered } from "../lib/history";
import { dateLabel } from "../lib/timeline";
import type { AnnualSeries } from "../types";

interface Props {
  series: AnnualSeries;
  forecast: ForecastInput | null;
  name: string;
}

const W = 320;
const H = 140;
const TIP_H = 16;

const idx = (v: number | null) => formatValue(v, "index");

// the year and the value, and for an expected level the band around it
function readout(h: Hovered): string {
  if (h.kind === "history") return `${h.point.year}: ${idx(h.point.value)}`;
  const band = h.point.lo !== null && h.point.hi !== null ? ` (${idx(h.point.lo)} to ${idx(h.point.hi)})` : "";
  return `${h.point.year} expected: ${idx(h.point.value)}${band}`;
}

// one series, so no legend: the title names it. the history is a solid
// line, the expected path a dashed one with its band as a wash, and a
// crosshair follows the pointer or the arrow keys
export function HistoryChart({ series, forecast, name }: Props) {
  const model = useMemo(() => buildHistory(series, forecast, W, H), [series, forecast]);
  const [hover, setHover] = useState<Hovered | null>(null);
  // a readout belongs to the series it was read off. the panel hands this
  // chart the next metro's series without a blur or a mouseleave when the
  // route moves from the keyboard, so a new series clears it here
  const [readOff, setReadOff] = useState(series);
  if (readOff !== series) {
    setReadOff(series);
    setHover(null);
  }
  const svg = useRef<SVGSVGElement>(null);
  const last = model.last;
  if (!last) return <p className="muted">no index values</p>;

  const asOf = dateLabel(series.as_of) ?? series.as_of;
  const toYear = model.years[1];
  // a short newest year is the index at as_of, not an annual mean, the way
  // the note beside the chart says it
  const partial = series.partial_year === last.year;
  const span = !partial
    ? `annual mean ${model.years[0]} to ${last.year}, the last through ${asOf}`
    : last.year > model.years[0]
      ? `annual mean ${model.years[0]} to ${last.year - 1}, then the index at ${asOf}`
      : `the index at ${asOf}`;
  const title = model.forecast.length
    ? `house price index for ${name}, ${span}, with the expected path to ${toYear}`
    : `house price index for ${name}, ${span}`;
  const anchor = (x: number) => (x < model.left + 12 ? "start" : x > model.right - 12 ? "end" : "middle");

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setHover(nearestPoint(model, ((e.clientX - box.left) * W) / box.width));
  };

  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const all = hoverables(model);
    const i = hover ? all.findIndex((h) => h.point.year === hover.point.year) : -1;
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = i < 0 ? (step > 0 ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, i + step));
    setHover(all[next] ?? null);
  };

  const text = hover ? readout(hover) : "";
  const tipW = text.length * 5.4 + 12;
  const tipX = hover ? (hover.point.x + 8 + tipW > W ? hover.point.x - 8 - tipW : hover.point.x + 8) : 0;

  return (
    <svg
      ref={svg}
      className="history"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={title}
      tabIndex={0}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
      onBlur={() => setHover(null)}
    >
      <title>{title}</title>
      {model.yTicks.map((t) => (
        <g key={t.value}>
          <line className="grid" x1={model.left} x2={model.right} y1={t.y} y2={t.y} />
          <text className="lbl" x={model.left - 6} y={t.y + 3} textAnchor="end">{idx(t.value)}</text>
        </g>
      ))}
      {model.xTicks.map((t) => (
        <text key={t.year} className="lbl" x={t.x} y={H - 5} textAnchor={anchor(t.x)}>{t.year}</text>
      ))}
      {model.bandD && (
        <path className="band" d={model.bandD}>
          <title>{`90 percent band around the expected index, ${model.forecast[0].year} to ${toYear}`}</title>
        </path>
      )}
      {model.forecastD && <path className="expected" d={model.forecastD} />}
      {model.forecast.map((p) => (
        <circle key={p.year} className="expected-dot" cx={p.x} cy={p.y} r={3}>
          <title>{readout({ kind: "forecast", point: p })}</title>
        </circle>
      ))}
      {model.d && <path className="line" d={model.d} />}
      <circle className="dot" cx={last.x} cy={last.y} r={4}>
        <title>{`${last.year}: ${idx(last.value)}, ${partial ? "the index at" : "through"} ${asOf}`}</title>
      </circle>
      <text className="lbl end" x={last.x} y={last.y - 8} textAnchor={anchor(last.x)}>{idx(last.value)}</text>
      {hover && (
        <g className="hover" aria-hidden="true">
          <line className="crosshair" x1={hover.point.x} x2={hover.point.x} y1={model.top} y2={model.bottom} />
          <circle className="ring" cx={hover.point.x} cy={hover.point.y} r={5} />
          <g transform={`translate(${tipX} 1)`}>
            <rect className="tip" width={tipW} height={TIP_H} rx={3} />
            <text className="tip-text" x={6} y={11.5}>{text}</text>
          </g>
        </g>
      )}
    </svg>
  );
}

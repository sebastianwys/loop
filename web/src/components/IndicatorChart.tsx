import { useMemo, useRef, useState, type ReactElement } from "react";
import { formatValue } from "../lib/format";
import {
  CHART_W, activeRangeId, buildIndicatorChart, chartTitle, clipHistory, displayFormat, indicatorRanges,
  nearestChartPoint, pointReadout, rangeMonths, type ChartPoint,
} from "../lib/indicators";
import type { Indicator } from "../types";
import "../styles/strip.css";

interface Props {
  indicator: Indicator;
  width?: number;
}

const TIP_H = 16;

// the monthly history, no axes. a dashed rule marks where the series stands
// today, and a crosshair follows the pointer or the arrow keys and reads out
// the month under it. the buttons above choose how far back it runs, and
// only spans the series can fill are offered
export function IndicatorChart({ indicator, width = CHART_W }: Props) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [hover, setHover] = useState<ChartPoint | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const ranges = useMemo(() => indicatorRanges(indicator.history), [indicator.history]);
  const active = activeRangeId(ranges, chosen);
  const shown = useMemo(
    () => clipHistory(indicator.history, rangeMonths(ranges, active)),
    [indicator.history, ranges, active],
  );
  const model = useMemo(() => buildIndicatorChart(shown, width), [shown, width]);

  const title = chartTitle(indicator, shown);
  const value = (v: number) => formatValue(v, displayFormat(indicator.format));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setHover(nearestChartPoint(model, ((e.clientX - box.left) * width) / box.width));
  };

  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (!model || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const step = e.key === "ArrowRight" ? 1 : -1;
    const i = hover ? model.points.findIndex((p) => p.date === hover.date) : -1;
    const next = i < 0 ? (step > 0 ? 0 : model.points.length - 1) : Math.min(model.points.length - 1, Math.max(0, i + step));
    setHover(model.points[next] ?? null);
  };

  // a crosshair on a month of the old window means nothing in the new one
  const pick = (id: string) => {
    setChosen(id);
    setHover(null);
  };

  // one span is no choice at all, so a series that fills none of them keeps
  // the plain chart it has always had
  const withRanges = (chart: ReactElement) =>
    ranges.length < 2 ? chart : (
      <div className="ind-chart-block">
        <div className="ind-range" role="group" aria-label="how far back the chart runs">
          {ranges.map((range) => (
            <button
              key={range.id}
              type="button"
              aria-pressed={range.id === active}
              aria-label={range.readout}
              onClick={() => pick(range.id)}
            >
              {range.label}
            </button>
          ))}
        </div>
        {chart}
      </div>
    );

  if (!model) return withRanges(<p className="muted">no monthly history</p>);

  const { last, height } = model;
  const text = hover ? pointReadout(hover, indicator.format) : "";
  const tipW = text.length * 5.4 + 12;
  const tipX = hover ? (hover.x + 8 + tipW > width ? hover.x - 8 - tipW : hover.x + 8) : 0;
  const anchor = last.x > width - 40 ? "end" : "middle";

  return withRanges(
    <svg
      ref={svg}
      className="ind-chart"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${title}, arrow keys read out each month`}
      tabIndex={0}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
      onBlur={() => setHover(null)}
    >
      <title>{title}</title>
      <line className="now" x1={0} x2={width} y1={last.y} y2={last.y} />
      {model.d && <path className="line" d={model.d} />}
      <circle className="dot" cx={last.x} cy={last.y} r={3} />
      <text className="lbl end" x={last.x} y={last.y - 8} textAnchor={anchor}>{value(last.value)}</text>
      {hover && (
        <g className="hover" aria-hidden="true">
          <line className="crosshair" x1={hover.x} x2={hover.x} y1={0} y2={height} />
          <circle className="ring" cx={hover.x} cy={hover.y} r={4} />
          <g transform={`translate(${tipX} 1)`}>
            <rect className="tip" width={tipW} height={TIP_H} rx={3} />
            <text className="tip-text" x={6} y={11.5}>{text}</text>
          </g>
        </g>
      )}
    </svg>,
  );
}

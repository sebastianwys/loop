import { useMemo, useRef, useState } from "react";
import {
  columnX, compareTitle, markerPath, nearestYear, readingAt, type ChartSize, type CompareModel, type Marker,
} from "../lib/compare";
import { formatValue } from "../lib/format";

interface Props {
  model: CompareModel;
  size: ChartSize;
}

const idx = (v: number | null) => formatValue(v, "index");

// the swatch a line is known by, the same one in the legend, the readout and
// the table: colour, dash and mark together, so none of the three is load
// bearing on its own
export function SeriesKey({ slot, marker, dash }: { slot: number; marker: Marker; dash: string }) {
  return (
    <svg className={`series-key series-${slot}`} width={26} height={12} viewBox="0 0 26 12" aria-hidden="true" focusable="false">
      <line className="line" x1={1} y1={6} x2={25} y2={6} strokeDasharray={dash || undefined} />
      <path className="mark" d={markerPath(marker, 13, 6, 3.5)} />
    </svg>
  );
}

// the overlay. every line is drawn on the one pair of axes, named at its end
// where there is room for a label, and read at a year by the pointer or the
// arrow keys. the readout is html under the chart rather than a tip inside
// it: four lines of numbers do not fit in a box on a phone
export function CompareChart({ model, size }: Props) {
  const [year, setYear] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const title = useMemo(() => compareTitle(model), [model]);

  const anchor = (x: number) => (x < model.left + 12 ? "start" : x > model.right - 12 ? "end" : "middle");

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setYear(nearestYear(model, ((e.clientX - box.left) * size.width) / box.width));
  };

  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const years = model.columns.map((column) => column.year);
    if (years.length === 0) return;
    const at = year === null ? -1 : years.indexOf(year);
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : years.length - 1) : Math.min(years.length - 1, Math.max(0, at + step));
    setYear(years[next]);
  };

  const cross = year === null ? null : columnX(model, year);
  const readings = year === null ? [] : readingAt(model, year);

  return (
    <div>
      <svg
        ref={svg}
        className="compare-chart"
        width={size.width}
        height={size.height}
        viewBox={`0 0 ${size.width} ${size.height}`}
        role="img"
        aria-label={title}
        tabIndex={0}
        onMouseMove={onMove}
        onMouseLeave={() => setYear(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setYear(null)}
      >
        <title>{title}</title>
        {model.yTicks.map((t) => (
          <g key={t.value}>
            <line className="grid" x1={model.left} x2={model.right} y1={t.y} y2={t.y} />
            <text className="lbl" x={model.left - 6} y={t.y + 3} textAnchor="end">{idx(t.value)}</text>
          </g>
        ))}
        {model.xTicks.map((t) => (
          <text key={t.year} className="lbl" x={t.x} y={size.height - 6} textAnchor={anchor(t.x)}>{t.year}</text>
        ))}
        {model.lines.map((line) => (
          <g key={line.cbsa} className={`series-${line.slot}`}>
            {size.labels && <path className="leader" d={`M ${line.last.x} ${line.last.y} L ${model.right + 7} ${line.labelY}`} />}
            <path className="line" d={line.d} strokeDasharray={line.dash || undefined} />
            <path className="mark" d={markerPath(line.marker, line.last.x, line.last.y, 4)} />
          </g>
        ))}
        {size.labels && model.lines.map((line) => (
          <text key={line.cbsa} className="end" x={model.right + 11} y={line.labelY + 3.5}>{line.short}</text>
        ))}
        {cross !== null && (
          <g className="hover" aria-hidden="true">
            <line className="crosshair" x1={cross} x2={cross} y1={model.top} y2={model.bottom} />
            {readings.map((reading) => reading.point && (
              <circle key={reading.cbsa} className={`ring series-${reading.slot}`} cx={reading.point.x} cy={reading.point.y} r={5} />
            ))}
          </g>
        )}
      </svg>
      <p className="compare-readout" aria-live="polite">
        {year === null ? (
          <span className="hint">point at the chart, or give it focus and use the arrow keys, to read a year</span>
        ) : (
          <>
            <span className="when">{year}</span>
            {readings.map((reading) => (
              <span className="read" key={reading.cbsa}>
                <SeriesKey slot={reading.slot} marker={reading.marker} dash={reading.dash} />
                {reading.short}
                <span className="v">{idx(reading.point?.value ?? null)}</span>
              </span>
            ))}
          </>
        )}
      </p>
    </div>
  );
}

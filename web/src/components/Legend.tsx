import { formatValue } from "../lib/format";
import type { Metric } from "../lib/metrics";
import type { ColorScale } from "../lib/scale";

interface Props {
  scale: ColorScale;
  metric: Metric;
  caption: string;
  open?: boolean;
  onToggle?: () => void;
  // true when at least one metro on the map is showing its parent's number
  inherited?: boolean;
  // true when the end classes take everything past them, so the reader is
  // not told a bin ends where values plainly carry on
  clipped?: boolean;
}

const BODY_ID = "legend-body";

// the key rolls up to its title line. on a phone it would otherwise cover a
// third of the map, so it starts rolled up there
export function Legend({ scale, metric, caption, open = true, onToggle, inherited = false, clipped = false }: Props) {
  const signed = scale.kind === "diverging";
  const last = scale.bins.length - 1;
  const range = (bin: { from: number; to: number }, i: number) => {
    const from = formatValue(bin.from, metric.format, signed);
    const to = formatValue(bin.to, metric.format, signed);
    if (!clipped) return `${from} to ${to}`;
    if (i === 0) return `${to} or less`;
    if (i === last) return `${from} or more`;
    return `${from} to ${to}`;
  };
  return (
    <div className={`legend${open ? "" : " closed"}`} role="group" aria-label="map legend">
      <div className="legend-head">
        <div className="title">{metric.label}</div>
        {onToggle && (
          <button
            type="button"
            className="roll"
            aria-expanded={open}
            aria-controls={BODY_ID}
            aria-label={open ? "roll up the legend" : "roll down the legend"}
            title={open ? "roll up the legend" : "roll down the legend"}
            onClick={onToggle}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="currentColor">
              {open ? <polygon points="1,6.5 5,2.5 9,6.5" /> : <polygon points="1,3.5 5,7.5 9,3.5" />}
            </svg>
          </button>
        )}
      </div>
      <div className="body" id={BODY_ID}>
        {scale.bins.map((bin, i) => (
          <div className="row" key={i}>
            <span className="sw" style={{ background: bin.color }} />
            <span>{range(bin, i)}</span>
          </div>
        ))}
        <div className="row">
          <span className="sw null" />
          <span>no data</span>
        </div>
        {inherited && (
          <div className="row">
            <span className="sw taken" style={{ background: scale.color(scale.bins[Math.floor(scale.bins.length / 2)]?.from ?? null) }} />
            <span>from the parent metro</span>
          </div>
        )}
        <div className="caption">{caption}</div>
      </div>
    </div>
  );
}

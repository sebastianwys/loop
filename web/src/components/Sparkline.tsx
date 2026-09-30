import { formatValue } from "../lib/format";
import { WITHHELD, type ValueFormat } from "../lib/metrics";
import { buildSparkline } from "../lib/sparkline";

interface Props {
  values: (number | null)[];
  labels: string[];
  title: string;
}

const W = 300;
const H = 64;
const PAD = 16;

// one series, so no legend box. only the two endpoints get a direct label,
// every point carries its value in a title for hover and screen readers
export function Sparkline({ values, labels, title }: Props) {
  const spark = buildSparkline(values, W, H, PAD);
  if (spark.points.length === 0) return <p className="muted">no index values</p>;

  const first = spark.points[0];
  const last = spark.points[spark.points.length - 1];
  const labelX = (i: number) =>
    labels.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (labels.length - 1);
  const anchor = (i: number) => (i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle");

  return (
    <svg className="spark" width={W} height={H + 14} viewBox={`0 0 ${W} ${H + 14}`} role="img" aria-label={title}>
      <title>{title}</title>
      <line className="base" x1={0} x2={W} y1={H} y2={H} />
      {spark.d && <path className="line" d={spark.d} />}
      {spark.points.map((p) => (
        <circle key={p.index} className="dot" cx={p.x} cy={p.y} r={4}>
          <title>{`${labels[p.index]}: ${formatValue(p.value, "index")}`}</title>
        </circle>
      ))}
      <text className="lbl" x={first.x} y={first.y - 8} textAnchor="start">
        {formatValue(first.value, "index")}
      </text>
      {last !== first && (
        <text className="lbl" x={last.x} y={last.y - 8} textAnchor="end">
          {formatValue(last.value, "index")}
        </text>
      )}
      {labels.map((label, i) => (
        <text key={label} className="lbl" x={labelX(i)} y={H + 12} textAnchor={anchor(i)}>
          {label}
        </text>
      ))}
    </svg>
  );
}

interface InlineProps {
  values: (number | null)[];
  labels: string[];
  format: ValueFormat;
  signed?: boolean;
  // true where the blank is one the build withheld, which reads differently
  // from a value nobody measured
  withheld?: boolean[];
}

const IW = 44;
const IH = 14;

// a hint of the shape across a table row's periods, no axis or labels. the
// title reads the values out in full, and a withheld blank says so
export function InlineSpark({ values, labels, format, signed = false, withheld = [] }: InlineProps) {
  const spark = buildSparkline(values, IW, IH, 3);
  if (spark.points.length === 0) return null;
  const text = labels
    .map((label, i) => `${label} ${withheld[i] && values[i] == null ? WITHHELD : formatValue(values[i] ?? null, format, signed)}`)
    .join(", ");
  return (
    <svg className="spark-inline" width={IW} height={IH} viewBox={`0 0 ${IW} ${IH}`} role="img" aria-label={text}>
      <title>{text}</title>
      {spark.d && <path className="line" d={spark.d} />}
      {spark.points.map((p) => (
        <circle key={p.index} className="dot" cx={p.x} cy={p.y} r={1.5} />
      ))}
    </svg>
  );
}

export interface SparkPoint {
  x: number;
  y: number;
  value: number;
  index: number;
}

export interface Spark {
  d: string;
  points: SparkPoint[];
  width: number;
  height: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

// path segments only join consecutive present values, so a null in the
// middle leaves a gap instead of bridging it
export function buildSparkline(values: (number | null)[], width = 160, height = 48, pad = 8): Spark {
  const present = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => typeof p.v === "number" && Number.isFinite(p.v));
  if (present.length === 0) return { d: "", points: [], width, height };

  const n = values.length;
  const min = Math.min(...present.map((p) => p.v));
  const max = Math.max(...present.map((p) => p.v));
  // a pad wider than half the box leaves nothing to draw in, and the arms
  // below go negative: the y scale then puts low values above high ones and
  // the line reads upside down. no caller is close, the inline spark is 14px
  // with a pad of 3, but a smaller tile is one css change away
  const padX = Math.max(0, Math.min(pad, width / 2));
  const padY = Math.max(0, Math.min(pad, height / 2));
  const x = (i: number) => (n === 1 ? width / 2 : padX + (i * (width - 2 * padX)) / (n - 1));
  const y = (v: number) => (max === min ? height / 2 : height - padY - ((v - min) * (height - 2 * padY)) / (max - min));

  const points = present.map((p) => ({ x: r1(x(p.i)), y: r1(y(p.v)), value: p.v, index: p.i }));
  let d = "";
  points.forEach((p, k) => {
    const prev = points[k - 1];
    const next = points[k + 1];
    if (prev && p.index === prev.index + 1) d += ` L ${p.x} ${p.y}`;
    else if (next && next.index === p.index + 1) d += ` M ${p.x} ${p.y}`;
  });
  return { d: d.trim(), points, width, height };
}

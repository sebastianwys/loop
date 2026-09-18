import type { ValueFormat } from "./metrics";

const usd = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v).toLocaleString("en-US")}`;

// null renders as a plain dash everywhere so a missing value never looks like zero
export function formatValue(value: number | null, format: ValueFormat, signed = false): string {
  if (value === null || !Number.isFinite(value)) return "-";
  const sign = signed && value > 0 ? "+" : "";
  switch (format) {
    case "pct":
      return `${sign}${(value * 100).toFixed(1)}%`;
    case "rate":
      return `${sign}${value.toFixed(1)}%`;
    // a gap between two rates, which is points rather than percent
    case "points":
      return `${sign}${value.toFixed(1)} pp`;
    case "ratio":
      return `${value.toFixed(1)}x`;
    case "int":
      return `${sign}${Math.round(value).toLocaleString("en-US")}`;
    case "index":
      return value.toFixed(1);
    case "usd":
      return usd(value);
    // bea reports personal income in thousands of dollars
    case "usd_k":
      return usd(value * 1000);
    case "days":
      return `${Math.round(value)} days`;
    case "minutes":
      return `${value.toFixed(1)} min`;
    case "per_1000":
      return `${sign}${value.toFixed(1)} per 1k`;
  }
}

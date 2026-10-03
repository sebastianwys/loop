import type { ValueFormat } from "./metrics";

// a metro's total personal income runs to billions, which read badly as $3000.00M
const usd = (v: number) =>
  v >= 1_000_000_000 ? `$${(v / 1_000_000_000).toFixed(2)}B`
    : v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v).toLocaleString("en-US")}`;

// null renders as a plain dash everywhere so a missing value never looks like zero
export function formatValue(value: number | null, format: ValueFormat, signed = false): string {
  if (value === null || !Number.isFinite(value)) return "-";
  // the sign goes on the number as printed, so a value that rounds to zero
  // prints as an unsigned zero, never -0.0 or +0.0
  const sign = (shown: number) => (signed && shown > 0 ? "+" : "");
  const fixed = (v: number, digits: number) => {
    const shown = Number(v.toFixed(digits)) || 0;
    return `${sign(shown)}${shown.toFixed(digits)}`;
  };
  switch (format) {
    case "pct":
      return `${fixed(value * 100, 1)}%`;
    case "rate":
      return `${fixed(value, 1)}%`;
    case "rate2":
      return `${fixed(value, 2)}%`;
    // a gap between two rates, which is points rather than percent
    case "points":
      return `${fixed(value, 1)} pp`;
    case "ratio":
      return `${value.toFixed(1)}x`;
    case "int": {
      const shown = Math.round(value) || 0;
      return `${sign(shown)}${shown.toLocaleString("en-US")}`;
    }
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
      return `${fixed(value, 1)} per 1k`;
  }
}

// an axis label. a round tick reads 20% or 400, not 20.0% or 400.0
export function formatTick(value: number, format: ValueFormat, signed = false): string {
  return formatValue(value, format, signed).replace(/(\d)\.0(?!\d)/, "$1");
}

// about how wide a label is at the 10px the charts set their ticks in
export const labelWidth = (text: string): number => Math.ceil(text.length * 6.2);

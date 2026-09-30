import { describe, expect, it } from "vitest";
import { formatValue } from "./format";

describe("formatValue", () => {
  it("renders null as a dash for every format", () => {
    for (const f of ["pct", "usd", "usd_k", "ratio", "rate", "rate2", "int", "index", "days", "minutes", "per_1000"] as const) {
      expect(formatValue(null, f)).toBe("-");
      expect(formatValue(Number.NaN, f)).toBe("-");
    }
  });

  it("formats each kind", () => {
    expect(formatValue(0.2081, "pct")).toBe("20.8%");
    expect(formatValue(44249, "usd")).toBe("$44,249");
    expect(formatValue(1234567, "usd")).toBe("$1.23M");
    expect(formatValue(2.08, "ratio")).toBe("2.1x");
    expect(formatValue(3.4, "rate")).toBe("3.4%");
    // a rate set in hundredths keeps them: the fed funds target at 4.25, not 4.3
    expect(formatValue(4.25, "rate2")).toBe("4.25%");
    expect(formatValue(4, "rate2")).toBe("4.00%");
    expect(formatValue(0.82, "rate2", true)).toBe("+0.82%");
    expect(formatValue(167171, "int")).toBe("167,171");
    expect(formatValue(186.892, "index")).toBe("186.9");
  });

  it("formats the enrichment kinds", () => {
    expect(formatValue(1234, "usd_k")).toBe("$1.23M");
    expect(formatValue(12, "usd_k")).toBe("$12,000");
    expect(formatValue(63.4, "days")).toBe("63 days");
    expect(formatValue(18.5, "minutes")).toBe("18.5 min");
    expect(formatValue(0.969, "per_1000")).toBe("1.0 per 1k");
  });

  it("signs positive values only when asked", () => {
    expect(formatValue(0.1, "pct", true)).toBe("+10.0%");
    expect(formatValue(-0.1, "pct", true)).toBe("-10.0%");
    expect(formatValue(0.1, "pct")).toBe("10.0%");
    expect(formatValue(15000, "int", true)).toBe("+15,000");
    expect(formatValue(-1.2, "per_1000", true)).toBe("-1.2 per 1k");
    expect(formatValue(0, "int", true)).toBe("0");
  });

  // north port's -0.0186 forecast read -0.0%, a direction the printed number
  // does not have. the sign goes on the number as printed
  it("prints a value that rounds to zero as an unsigned zero", () => {
    expect(formatValue(-0.0186, "rate", true)).toBe("0.0%");
    expect(formatValue(0.0096, "points", true)).toBe("0.0 pp");
    expect(formatValue(-0.003, "per_1000", true)).toBe("0.0 per 1k");
    expect(formatValue(-0.0004, "pct", true)).toBe("0.0%");
    expect(formatValue(0.004, "rate2", true)).toBe("0.00%");
    expect(formatValue(-0.4, "int", true)).toBe("0");
    expect(formatValue(-0.4, "int")).toBe("0");
    // and anything that does not round to zero keeps its sign
    expect(formatValue(-0.06, "rate", true)).toBe("-0.1%");
    expect(formatValue(0.06, "points", true)).toBe("+0.1 pp");
  });
});

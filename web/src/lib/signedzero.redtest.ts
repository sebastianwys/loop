// a red test. run it on purpose:
//   cd web && npx vitest run --config redtest.config.ts src/lib/signedzero.redtest.ts
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatValue } from "./format";
import { DEFS } from "./metrics";
import type { MapData, Period } from "../types";

const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

// a zero with a sign on it, at whatever precision and in whatever unit
const SIGNED_ZERO = /^[+-]0(?:\.0+)?(?:%| pp| per 1k)?$/;

describe("a figure that rounds to zero", () => {
  it("prints as an unsigned zero in every signed format", () => {
    expect(formatValue(-0.0186, "rate", true)).toBe("0.0%");
    expect(formatValue(0.0096, "points", true)).toBe("0.0 pp");
    expect(formatValue(-0.002, "points", true)).toBe("0.0 pp");
    expect(formatValue(-0.003, "per_1000", true)).toBe("0.0 per 1k");
    expect(formatValue(-0.0004, "pct", true)).toBe("0.0%");
    expect(formatValue(0.004, "rate2", true)).toBe("0.00%");
    expect(formatValue(-0.4, "int", true)).toBe("0");
    expect(formatValue(0.4, "int", true)).toBe("0");
  });

  it("keeps the sign of anything that does not round to zero", () => {
    expect(formatValue(-0.06, "rate", true)).toBe("-0.1%");
    expect(formatValue(0.06, "points", true)).toBe("+0.1 pp");
    expect(formatValue(-0.6, "int", true)).toBe("-1");
  });
});

describe.skipIf(!present)("the shipped build", () => {
  it("prints no signed zero in any metric, at any period, the way the map and the tables sign them", () => {
    const found: string[] = [];
    for (const def of DEFS) {
      const periods: (Period | null)[] = def.periods.length ? def.periods : [null];
      for (const metro of data!.metros) {
        for (const period of periods) {
          const text = formatValue(def.valueAt(metro, period), def.format, def.kind === "diverging");
          if (SIGNED_ZERO.test(text)) found.push(`${metro.cbsa} ${def.id} ${period ?? ""} ${def.valueAt(metro, period)} as ${text}`);
        }
      }
    }
    expect(found.length, `first: ${found.slice(0, 4).join("; ")}`).toBe(0);
  });
});

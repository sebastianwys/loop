// a red test. the build side of the same note, a 1.0 nobody measured, is in
// tests/redtest_footprint_share.py.
// run it deliberately, the green include does not pick a *.redtest.ts up:
//   cd web && npx vitest run --config redtest.config.ts src/lib/footprint.redtest.ts

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { footprintNote } from "./geo";
import type { MapData, Metro } from "../types";

// the built json is optional in ci, so the shipped half skips when it is absent
const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

const base = { cbsa: "1", name: "x", lat: 0, lon: 0 } as unknown as Metro;

// every share of a metro's people a note states, in percent
function sharesOfPeople(note: string | null): number[] {
  if (!note) return [];
  return [...note.matchAll(/(\d+(?:\.\d+)?) percent of (?:its|the metro's) people/g)].map((m) => Number(m[1]));
}

// the measure behind the note is settled: the people in the counties a metro
// gained plus the people in the ones it lost, over what it held at the earlier
// vintage. a complete swap, connecticut's counties for its planning regions,
// comes to about 2.0 by construction. that is a turnover, and a share of a
// metro's people cannot pass one hundred percent, so the number is right and
// the sentence that calls it a share of people is not
describe("a footprint note never states more than all of a metro's people", () => {
  it("words bridgeport's 2.0237 as something other than 202.37 percent of its people", () => {
    const note = footprintNote({ ...base, footprint_refused: 2.0237 });
    // the rates are still withheld, and the note still says so
    expect(note).toContain("withheld");
    for (const share of sharesOfPeople(note)) expect(share, note ?? "").toBeLessThanOrEqual(100);
  });

  // the control: the note still carries the measured figure, however it is worded
  it("still states salisbury's measured 66.85 percent", () => {
    const note = footprintNote({ ...base, footprint_refused: 0.6685 });
    expect(note).toContain("66.85 percent");
    expect(note).toContain("withheld");
  });
});

describe.skipIf(!present)("the footprint notes the map ships", () => {
  it("state no share of a metro's people above one hundred percent", () => {
    const over = data!.metros
      .map((m) => ({ m, shares: sharesOfPeople(footprintNote(m)) }))
      .filter(({ shares }) => shares.some((s) => s > 100))
      .map(({ m, shares }) => `${m.cbsa} ${m.name}: ${shares.join(", ")} percent of its people`);
    expect(over).toEqual([]);
  });
});

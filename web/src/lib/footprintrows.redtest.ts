// a red test. run it on purpose:
//   cd web && npx vitest run --config redtest.config.ts src/lib/footprintrows.redtest.ts
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DetailPanel } from "../components/DetailPanel";
import type { MapData } from "../types";

const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

const plain = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// cleveland gained ashtabula, so its three acs decade rates are withheld. the
// two fhfa changes in the same table are printed, and fhfa's index is built on
// today's county lines for every year, so nothing about them was withheld
describe.skipIf(!present)("the note under the Change table", () => {
  it("names the rates it withheld rather than every change above it", () => {
    const cleveland = data!.metros.find((m) => m.cbsa === "17410")!;
    expect(cleveland.footprint_refused).toBeGreaterThan(0.02);
    expect(cleveland.growth.hpi_14_19).not.toBeNull();
    expect(cleveland.growth.hpi_19_24).not.toBeNull();
    for (const key of ["income_14_24", "home_value_14_24", "pop_14_24"] as const) expect(cleveland.growth[key]).toBeNull();

    const markup = renderToStaticMarkup(createElement(DetailPanel, { metro: cleveland, metros: [cleveland], onClose: () => {} }));
    const from = markup.indexOf("<h3>Change</h3>");
    const table = plain(markup.slice(from, markup.indexOf("</table>", from)));
    expect(table).toContain("HPI, 2014 to 2019 +22.5%");
    expect(table).toContain("HPI, 2019 to 2024 +55.4%");
    const note = plain(/<p class="geo-note">([\s\S]*?)<\/p>/.exec(markup.slice(from))?.[1] ?? "");
    expect(note).toContain("withheld");
    expect(note, note).not.toMatch(/the changes above are withheld/);
    expect(note).toMatch(/income/);
    expect(note).toMatch(/home value/);
    expect(note).toMatch(/population/);
  });
});

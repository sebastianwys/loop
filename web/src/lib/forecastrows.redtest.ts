// a red test.
// run it on purpose, the green include does not pick a *.redtest.ts up:
//   cd web && npx vitest run --config redtest.config.ts src/lib/forecastrows.redtest.ts
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DetailPanel } from "../components/DetailPanel";
import { FORECAST_FIELDS, forecastExplainer } from "./forecast";
import { dateAt, fieldAt, labelFor } from "./metrics";
import { dateLabel } from "./timeline";
import type { MapData, Metro } from "../types";

// the built json is optional in ci, so this suite skips when it is absent
const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

const plain = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// the rows of the detail panel's Forecasts table, as the words a reader sees
function forecastRows(metro: Metro): string[] {
  const markup = renderToStaticMarkup(createElement(DetailPanel, { metro, metros: [metro], onClose: () => {} }));
  const from = markup.indexOf("<h3>Forecasts");
  if (from < 0) return [];
  const table = markup.slice(markup.indexOf("<table>", from), markup.indexOf("</table>", from));
  return table.split("<tr>").slice(1).map(plain);
}

// the one date the table carries for all its rows, in the question mark's
// source line: "Source: Loop model, origin 2026-06"
const captionOrigin = (metro: Metro) => /origin (\S+)$/.exec(forecastExplainer(metro).source)?.[1] ?? null;

// a row shows a date when it carries the month or its label in words
const shows = (row: string, date: string) => row.includes(date) || row.includes(dateLabel(date) ?? date);

describe.skipIf(!present)("the surprise row of the detail panel's Forecasts table", () => {
  const abilene = () => data!.metros.find((m) => m.cbsa === "10180")!;

  it("is dated by the call it scores, not by the origin of the forecasts above it", () => {
    const metro = abilene();
    // the export dates the surprise at the quarter the scored call was made,
    // four quarters before the live forecasts
    expect(dateAt(metro, "latest", "hpi_surprise_4q")).toBe("2025-06");
    expect(dateAt(metro, "latest", "hpi_forecast_4q")).toBe("2026-06");
    expect(captionOrigin(metro)).toBe("2026-06");

    const row = forecastRows(metro).find((r) => r.startsWith(labelFor("hpi_surprise_4q")));
    expect(row, "no surprise row in the table").toBeDefined();
    expect(shows(row!, "2025-06"), `the surprise row reads "${row}" under a caption of origin 2026-06`).toBe(true);
  });

  it("dates every row whose field is dated apart from the caption, across the build", () => {
    const undated: string[] = [];
    for (const metro of data!.metros) {
      const origin = captionOrigin(metro);
      const rows = forecastRows(metro);
      for (const id of FORECAST_FIELDS) {
        const date = dateAt(metro, "latest", id);
        if (fieldAt(metro, "latest", id) === null || date === null || date === origin) continue;
        const row = rows.find((r) => r.startsWith(labelFor(id)));
        if (!row || !shows(row, date)) undated.push(`${metro.cbsa} ${id} ${date}`);
      }
    }
    expect(undated.length, `rows dated apart from the caption with no date of their own, first: ${undated.slice(0, 3).join("; ")}`)
      .toBe(0);
  });
});

// a red test. run it on purpose:
//   cd web && npx vitest run --config redtest.config.ts src/lib/forecastgroup.redtest.ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelPage } from "../components/ModelPage";
import { SAMPLE } from "./data";
import { DEFS } from "./metrics";
import { DEFAULT_ROUTE } from "./route";
import type { Shell } from "./views";

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

const html = renderToStaticMarkup(createElement(ModelPage, {
  data: SAMPLE,
  route: { ...DEFAULT_ROUTE, view: "model" },
  go: () => {},
  viewport: { width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false },
  shell,
}));
const paragraphs = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim());

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

// the map's Forecasts group: the model's two expected growth lines, and beside
// them realized fhfa growth over four quarters and over five years, the
// surprise, which scores an old call against what happened, and fhfa's error
describe("what the model page says the Forecasts group holds", () => {
  const group = DEFS.filter((d) => d.group === "Forecasts");
  const notForecasts = group.filter((d) => !d.id.startsWith("hpi_forecast_"));

  it("counts the numbers in it that are not forecasts the way the group does", () => {
    expect(notForecasts.map((d) => d.id)).toEqual(["hpi_trend_5y", "hpi_yoy_latest", "hpi_surprise_4q", "hpi_index_error"]);
    for (const text of paragraphs) {
      const claim = /\b(\w+) numbers? in the map's Forecasts group (?:is|are) not a forecast/i.exec(text);
      if (claim) expect(WORDS[claim[1].toLowerCase()], claim[0]).toBe(notForecasts.length);
    }
  });

  it("names each of them as not a forecast", () => {
    const about = paragraphs.find((p) => p.includes("Forecasts group"));
    expect(about, "no paragraph on the Forecasts group").toBeDefined();
    expect(about).toMatch(/index standard error/i);
    expect(about).toMatch(/surprise/i);
    expect(about).toMatch(/last (?:four|4) quarters/i);
    expect(about).toMatch(/(?:five|5) year/i);
  });
});

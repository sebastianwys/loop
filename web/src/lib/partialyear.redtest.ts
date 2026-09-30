// red tests: the newest year of an fhfa history is a partial one, and its
// point is the index at as_of, not an annual mean. run it on purpose:
//   cd web && npx vitest run --config redtest.config.ts src/lib/partialyear.redtest.ts
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComparePage } from "../components/ComparePage";
import { HistoryChart } from "../components/HistoryChart";
import { forecastOf } from "./history";
import { DEFAULT_ROUTE } from "./route";
import type { Shell } from "./views";
import type { MapData, Metro } from "../types";

const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

const plain = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const metro = (cbsa: string): Metro => data!.metros.find((m) => m.cbsa === cbsa)!;

// baltimore's history runs from 1977 and ends in 2026, a year fhfa has
// published two quarters of. the build carries the 2026q2 level for it
function premise() {
  const series = metro("12580").series!.hpi!;
  expect(series.partial_year).toBe(2026);
  expect(series.as_of).toBe("2026Q2");
  expect(series.values[series.values.length - 1]).toBe(series.anchor);
  return series;
}

describe.skipIf(!present)("the compare page on a partial newest year", () => {
  const markup = () => renderToStaticMarkup(createElement(ComparePage, {
    data: data!,
    route: { ...DEFAULT_ROUTE, view: "compare", compare: ["12580", "17410", "16984"] },
    go: () => {},
    viewport: { width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false },
    shell,
  }));

  it("does not call the partial year's point an annual mean in the footnote", () => {
    premise();
    const feet = [...markup().matchAll(/<p class="compare-foot">([\s\S]*?)<\/p>/g)].map((m) => plain(m[1]));
    const foot = feet.find((f) => f.startsWith("House prices"));
    expect(foot, "no house price footnote").toBeDefined();
    expect(foot).not.toMatch(/annual mean, the last year through/);
    expect(foot).toContain("through 2025");
    expect(foot).toContain("index at 2026Q2");
  });

  it("dates baltimore's last index cell by the quarter it is, not the bare year", () => {
    premise();
    const row = markup().split('<tr><th scope="row">').find((chunk) => chunk.includes(`${metro("12580").name}</span></th>`));
    expect(row, "no compare row for baltimore").toBeDefined();
    const cells = row!.slice(0, row!.indexOf("</tr>"));
    expect(cells).not.toContain('<span class="date">2026</span>');
    expect(cells).toContain('<span class="date">2026Q2</span>');
  });
});

describe.skipIf(!present)("the price history chart on a partial newest year", () => {
  const chart = () => {
    const baltimore = metro("12580");
    return renderToStaticMarkup(createElement(HistoryChart, {
      series: baltimore.series!.hpi!, forecast: forecastOf(baltimore), name: baltimore.name,
    }));
  };

  it("names the partial point as the index at as_of in the chart's title", () => {
    premise();
    const title = /<svg[^>]*aria-label="([^"]*)"/.exec(chart())?.[1] ?? "";
    expect(title).not.toMatch(/annual mean 1977 to 2026/);
    expect(title).toContain("annual mean 1977 to 2025");
    expect(title).toContain("index at 2026Q2");
  });

  it("names it the same way on the last dot", () => {
    premise();
    const dot = /<circle class="dot"[^>]*><title>([^<]*)<\/title>/.exec(chart())?.[1] ?? "";
    expect(dot).toContain("index at 2026Q2");
    expect(dot).not.toMatch(/through 2026Q2/);
  });
});

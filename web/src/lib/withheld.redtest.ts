// a red test.
// run it deliberately, the green include does not pick a *.redtest.ts up:
//   cd web && npx vitest run --config redtest.config.ts src/lib/withheld.redtest.ts

import { existsSync, readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ComparePage } from "../components/ComparePage";
import { DetailPanel } from "../components/DetailPanel";
import { ExplorePage } from "../components/ExplorePage";
import { MapPage } from "../components/MapPage";
import { DEFAULT_ROUTE, type RouteState } from "./route";
import type { Shell } from "./views";
import type { MapData, Metro } from "../types";

// leaflet reads window at import and this suite has no dom. only the map
// library is swapped out: each dot becomes an <i> that keeps what a reader
// gets from it, the tooltip MapView builds and the fill and outline it asks for
vi.mock("leaflet", () => ({ canvas: () => ({}), latLng: (lat: number, lng: number) => ({ lat, lng }) }));
vi.mock("react-leaflet", async () => {
  const { createElement: h } = await vi.importActual<typeof import("react")>("react");
  return {
    MapContainer: ({ children }: { children?: ReactNode }) => h("div", { className: "map-stub" }, children),
    TileLayer: () => null,
    CircleMarker: ({ children, pathOptions }: { children?: ReactNode; pathOptions: { fillColor?: string; dashArray?: string } }) =>
      h("i", { className: "dot", "data-fill": pathOptions.fillColor, "data-dash": pathOptions.dashArray ?? "" }, children),
    Tooltip: ({ children }: { children?: ReactNode }) => h("span", { className: "tip" }, children),
    useMap: () => ({}),
  };
});

// the built json is optional in ci, so this suite skips when it is absent
const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};
const viewport = { width: 1440, height: 900, mode: "wide" as const, coarse: false, reducedMotion: false };
const page = (component: typeof MapPage, route: Partial<RouteState>) =>
  renderToStaticMarkup(createElement(component, { data: data!, route: { ...DEFAULT_ROUTE, ...route }, go: () => {}, viewport, shell }));

const metro = (cbsa: string): Metro => data!.metros.find((m) => m.cbsa === cbsa)!;
const WITHHELD = /withh[eo]ld/i;

// cleveland gained ashtabula, 4.70 percent of its people, so its three acs
// decade rates are withheld: both income vintages are there to divide, the
// build refused to. lexington park has no 2014 vintage at all, so nobody
// measured its rates and nothing was withheld
const CLEVELAND = "17410";
const LEXINGTON_PARK = "30500";
const DECADE_ACS = ["income_14_24", "home_value_14_24", "pop_14_24"] as const;

function premise() {
  const refused = metro(CLEVELAND);
  const unmeasured = metro(LEXINGTON_PARK);
  expect(refused.footprint_refused).toBeGreaterThan(0.02);
  expect(refused.years["2014"].income).not.toBeNull();
  expect(refused.years["2024"].income).not.toBeNull();
  expect(unmeasured.footprint_refused).toBeUndefined();
  expect(unmeasured.years["2014"].income ?? null).toBeNull();
  for (const key of DECADE_ACS) {
    expect(refused.growth[key], key).toBeNull();
    expect(unmeasured.growth[key], key).toBeNull();
  }
  // across the build: 92 metros have no decade income rate, 78 of them withheld
  const blank = data!.metros.filter((m) => m.growth.income_14_24 === null);
  expect(blank).toHaveLength(92);
  expect(blank.filter((m) => m.footprint_refused !== undefined)).toHaveLength(78);
}

// one dot's tooltip as the words a reader sees, with the metro's own name
// taken out so two metros can be compared on what they say about the value
function tooltip(markup: string, name: string): string {
  const dot = markup.split('<i class="dot"').find((chunk) => chunk.includes(`>${name}<`));
  if (!dot) throw new Error(`no dot for ${name}`);
  const body = dot.slice(0, dot.indexOf("</i>"));
  return body.slice(body.indexOf('<span class="tip">')).replace(/<[^>]+>/g, "").replace(name, "").trim();
}

// the compare table's cell for the chosen metric, the first td of the row, as
// markup so a title on the cell counts as well as its text
function compareCell(markup: string, name: string): string {
  const row = markup.split('<tr><th scope="row">').find((chunk) => chunk.includes(`${name}</span></th>`));
  if (!row) throw new Error(`no compare row for ${name}`);
  const cells = row.slice(row.indexOf("</th>") + 5);
  return cells.slice(0, cells.indexOf("</td>") + 5);
}

// commit 09c1e49 ("a withheld rate and a rate nobody measured were the same
// blank cell") reached one surface: footprintNote, read only by the detail
// panel, under its Change table. geo.ts says the note carries the whole weight
// there. every other surface that shows these three rates still reads
// footprint_refused nowhere, so a withheld rate is drawn, described, keyed and
// counted exactly as a rate nobody measured. bot/build_map_data.py states why
// that is wrong: "a withheld number and a number nobody measured are different
// claims and a blank cell cannot tell them apart"
describe.skipIf(!present)("a decade rate withheld because the county lines moved, away from the detail panel", () => {
  it("reads differently from an unmeasured rate in the map tooltip, and says withheld", () => {
    premise();
    // the one surface the fix reached tells the two apart, which is the contrast
    const panel = (cbsa: string) =>
      renderToStaticMarkup(createElement(DetailPanel, { metro: metro(cbsa), metros: data!.metros, onClose: () => {} }));
    expect(panel(CLEVELAND)).toContain("withheld rather than measured");
    expect(panel(LEXINGTON_PARK)).not.toMatch(WITHHELD);

    for (const key of DECADE_ACS) {
      const markup = page(MapPage, { metric: key });
      const withheld = tooltip(markup, "Cleveland, OH");
      const unmeasured = tooltip(markup, "Lexington Park, MD");
      expect(withheld, key).not.toBe(unmeasured);
      expect(withheld, key).toMatch(WITHHELD);
      expect(unmeasured, key).not.toMatch(WITHHELD);
    }
  });

  it("has a line in the map legend, so 78 withheld metros are not keyed as no data", () => {
    premise();
    const markup = page(MapPage, { metric: "income_14_24" });
    const legend = markup.slice(markup.indexOf('<div class="legend'));
    expect(legend).toContain("no data");
    expect(legend).toMatch(WITHHELD);
  });

  it("reads differently from an unmeasured rate in the compare table, and says withheld", () => {
    premise();
    const markup = page(ComparePage, { view: "compare", metric: "income_14_24", compare: [CLEVELAND, LEXINGTON_PARK] });
    const withheld = compareCell(markup, "Cleveland, OH");
    const unmeasured = compareCell(markup, "Lexington Park, MD");
    expect(withheld).not.toBe(unmeasured);
    expect(withheld).toMatch(WITHHELD);
    expect(unmeasured).not.toMatch(WITHHELD);
  });

  it("is counted apart from the unmeasured in the explore view's missing count", () => {
    premise();
    const markup = page(ExplorePage, { view: "explore", metric: "income_14_24" });
    const facts = markup.slice(markup.indexOf('<div class="explore-facts">'), markup.indexOf("explore-caution"));
    expect(facts).toContain("Median income growth, 2014 to 2024");
    expect(facts).toMatch(WITHHELD);
  });
});

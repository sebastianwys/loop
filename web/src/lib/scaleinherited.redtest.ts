// a red test. run it on purpose:
//   cd web && npx vitest run --config redtest.config.ts src/lib/scaleinherited.redtest.ts
import { existsSync, readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MapPage } from "../components/MapPage";
import { formatValue } from "./format";
import { defById, isInherited, resolveMetric } from "./metrics";
import { DEFAULT_ROUTE } from "./route";
import { buildScale } from "./scale";
import type { Shell } from "./views";
import type { MapData } from "../types";

// leaflet reads window at import and this suite has no dom. each dot becomes
// an <i> that keeps its fill and its tooltip, and nothing else changes
vi.mock("leaflet", () => ({ canvas: () => ({}), latLng: (lat: number, lng: number) => ({ lat, lng }) }));
vi.mock("react-leaflet", async () => {
  const { createElement: h } = await vi.importActual<typeof import("react")>("react");
  return {
    MapContainer: ({ children }: { children?: ReactNode }) => h("div", { className: "map-stub" }, children),
    TileLayer: () => null,
    CircleMarker: ({ children, pathOptions }: { children?: ReactNode; pathOptions: { fillColor?: string } }) =>
      h("i", { className: "dot", "data-fill": pathOptions.fillColor }, children),
    Tooltip: ({ children }: { children?: ReactNode }) => h("span", { className: "tip" }, children),
    useMap: () => ({}),
  };
});

const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};
const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, "\"");

// active listings at latest: 410 metros carry it, 37 of them divisions showing
// the parent metro's number. none of the 13 parents is in the build, so new
// york's count sits on four dots and is still one measurement
describe.skipIf(!present)("the map's colour classes over inherited values", () => {
  const metric = () => resolveMetric(defById("active_listings")!.def, "latest");
  const own = () => buildScale(data!.metros.filter((m) => !isInherited(m, metric())).map(metric().accessor), metric().kind);
  const markup = () => renderToStaticMarkup(createElement(MapPage, {
    data: data!,
    route: { ...DEFAULT_ROUTE, metric: "active_listings", period: "latest" },
    go: () => {},
    viewport: { width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false },
    shell,
  }));

  it("sets the class edges from the metros' own measurements", () => {
    const inherited = data!.metros.filter((m) => isInherited(m, metric()) && metric().accessor(m) !== null);
    expect(inherited).toHaveLength(37);

    const legend = markup().slice(markup().indexOf('class="legend'));
    const rows = [...legend.matchAll(/<span class="sw" style="background:[^"]+"><\/span><span>([^<]+)<\/span>/g)].map((m) => m[1]);
    const expected = own().bins;
    expect(rows).toHaveLength(expected.length);
    // the inner edges, whichever way the end classes are worded
    const inner = rows.slice(0, -1).map((text) => /(?:to )?([-+0-9.,]+)(?: or less)?$/.exec(text)?.[1]);
    expect(inner).toEqual(expected.slice(0, -1).map((bin) => formatValue(bin.to, metric().format)));
  });

  it("colours every metro's own measurement by that scale", () => {
    const scale = own();
    const fill = new Map<string, string>();
    for (const chunk of markup().split('<i class="dot"').slice(1)) {
      const name = /<span class="tn">([^<]*)<\/span>/.exec(chunk)?.[1];
      const color = /data-fill="([^"]*)"/.exec(chunk)?.[1];
      if (name && color) fill.set(unescape(name), color);
    }
    const wrong = data!.metros
      .filter((m) => !isInherited(m, metric()) && metric().accessor(m) !== null)
      .filter((m) => fill.get(m.name) !== scale.color(metric().accessor(m)));
    expect(wrong.length, `own metros drawn in another class, first: ${wrong.slice(0, 3).map((m) => m.name).join("; ")}`).toBe(0);
  });
});

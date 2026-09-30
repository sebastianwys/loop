import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SAMPLE } from "../lib/data";
import { metricById } from "../lib/metrics";
import { buildScale } from "../lib/scale";
import type { Metro } from "../types";
import { MapView } from "./MapView";

// leaflet reads window at import and this suite has no dom. only the map
// library is swapped out: each dot becomes an <i> holding the tooltip
// MapView builds for it, which is what a reader hovering the dot is told
vi.mock("leaflet", () => ({ canvas: () => ({}), latLng: (lat: number, lng: number) => ({ lat, lng }) }));
vi.mock("react-leaflet", async () => {
  const { createElement: h } = await vi.importActual<typeof import("react")>("react");
  return {
    MapContainer: ({ children }: { children?: ReactNode }) => h("div", null, children),
    TileLayer: () => null,
    CircleMarker: ({ children }: { children?: ReactNode }) => h("i", { className: "dot" }, children),
    Tooltip: ({ children }: { children?: ReactNode }) => h("span", { className: "tip" }, children),
    useMap: () => ({}),
  };
});

// one dot's tooltip as the words a reader sees
function tooltip(markup: string, name: string): string {
  const dot = markup.split('<i class="dot">').find((chunk) => chunk.includes(`>${name}<`));
  if (!dot) throw new Error(`no dot for ${name}`);
  return dot.slice(0, dot.indexOf("</i>")).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// a withheld rate and a rate nobody measured are both blank, and the dot's
// tooltip is where a reader on the map finds out which one they are looking at
describe("a dot's tooltip on a blank", () => {
  const [abilene, dallas] = SAMPLE.metros;
  const draw = (metros: Metro[], id: string) => {
    const metric = metricById(id);
    return renderToStaticMarkup(
      <MapView
        metros={metros}
        metric={metric}
        scale={buildScale(metros.map(metric.accessor), metric.kind)}
        selectedCbsa={null}
        onSelect={() => {}}
        mode="dots"
        boundaries={null}
      />,
    );
  };

  it("says withheld, with why, for a decade rate the build withheld, and the dash for one nobody measured", () => {
    const blank = (m: Metro) => ({ ...m.growth, income_14_24: null });
    const refused: Metro = { ...abilene, growth: blank(abilene), footprint_refused: 0.047 };
    const unmeasured: Metro = { ...dallas, growth: blank(dallas) };
    const markup = draw([refused, unmeasured], "income_14_24");
    expect(tooltip(markup, "Abilene, TX")).toBe("Abilene, TX withheld 2014 to 2024, county lines moved");
    expect(tooltip(markup, "Dallas-Fort Worth-Arlington, TX")).toBe("Dallas-Fort Worth-Arlington, TX - 2014 to 2024");
  });

  it("says withheld for a year's permit rate counted over different counties", () => {
    const marked: Metro = { ...abilene, years: { ...abilene.years, "2014": { ...abilene.years["2014"], permits_footprint: 0.378 } } };
    const markup = draw([marked, dallas], "permits_per_1000_2014");
    expect(tooltip(markup, "Abilene, TX")).toBe("Abilene, TX withheld 2014, counted over different counties");
    expect(tooltip(markup, "Dallas-Fort Worth-Arlington, TX")).not.toContain("withheld");
  });
});

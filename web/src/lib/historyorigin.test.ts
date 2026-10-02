import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DetailPanel } from "../components/DetailPanel";
import { dateAt } from "./metrics";
import type { MapData, Metro } from "../types";

const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

const panel = (metro: Metro) => renderToStaticMarkup(createElement(DetailPanel, { metro, metros: [metro], onClose: () => {} }));

// the chart grows the model's percents from series.anchor, the index at the
// series' as_of quarter. the percents were measured from the index at the
// forecast's own origin. the map rebuilds off each fhfa release while the
// model is refit by hand, so the two can part: fhfa publishes 2026q3 and the
// forecast is still the 2026q2 one
describe.skipIf(!present)("the expected path on the price chart", () => {
  const chicago = () => data!.metros.find((m) => m.cbsa === "16984")!;

  it("is drawn when the forecast was made at the quarter the series ends", () => {
    const metro = chicago();
    expect(metro.series!.hpi!.as_of).toBe("2026Q2");
    expect(dateAt(metro, "latest", "hpi_forecast_4q")).toBe("2026-06");
    expect(panel(metro)).toContain('class="expected"');
  });

  it("is not grown from a quarter the forecast was not made at", () => {
    const metro = chicago();
    const series = metro.series!.hpi!;
    const moved = series.anchor! * 1.05;
    const later: Metro = {
      ...metro,
      series: { hpi: { ...series, as_of: "2026Q3", anchor: moved, values: [...series.values.slice(0, -1), moved] } },
    };
    expect(dateAt(later, "latest", "hpi_forecast_4q")).toBe("2026-06");
    const markup = panel(later);
    expect(markup, "an expected path grown from the 2026q3 level").not.toContain('class="expected"');
    expect(markup, "a band grown from the 2026q3 level").not.toContain('class="band"');
  });
});

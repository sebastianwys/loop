import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DASHES } from "../lib/compare";
import { SAMPLE } from "../lib/data";
import { DEFAULT_ROUTE, type RouteState } from "../lib/route";
import type { Shell } from "../lib/views";
import type { LayoutMode } from "../lib/layout";
import type { MapData, Metro } from "../types";
import { ComparePage } from "./ComparePage";

// no dom in this suite, so the markup is read as a string: it proves what a
// reader who cannot see colour, or is listening to the page, is given

const history = SAMPLE.metros[0].series!.hpi!;

const withHistory = (metro: Metro, shift: number): Metro => ({
  ...metro,
  series: { hpi: { ...history, values: history.values.map((v) => (v === null ? null : v + shift)) } },
});

const data: MapData = {
  ...SAMPLE,
  metros: [SAMPLE.metros[0], withHistory(SAMPLE.metros[1], 60), withHistory(SAMPLE.metros[2], -30)],
};

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

const render = (data: MapData, compare: string[], mode: LayoutMode, route: Partial<RouteState>) =>
  renderToStaticMarkup(
    <ComparePage
      data={data}
      route={{ ...DEFAULT_ROUTE, view: "compare", compare, ...route }}
      go={() => {}}
      viewport={{ width: 1440, height: 900, mode, coarse: false, reducedMotion: false }}
      shell={shell}
    />,
  );

const page = (compare: string[], mode: LayoutMode = "wide", route: Partial<RouteState> = {}) =>
  render(data, compare, mode, route);

// the first metro of the three carries no history at all
const bare = (compare: string[]) =>
  render({ ...data, metros: [{ ...data.metros[0], series: null }, data.metros[1], data.metros[2]] }, compare, "wide", {});

describe("the compare view", () => {
  it("draws one chart for the metros in the address bar", () => {
    const markup = page(["10180", "19100"]);
    expect(markup).toContain('class="compare-chart"');
    expect(markup).toContain('role="img"');
    // the chart names both metros to a reader who cannot see it
    expect(markup).toContain("Abilene, TX");
    expect(markup).toContain("Dallas-Fort Worth-Arlington, TX");
  });

  it("asks for a second metro rather than drawing a comparison of one", () => {
    const markup = page(["10180"]);
    expect(markup).toContain("One more metro");
    expect(markup).not.toContain('class="compare-chart"');
  });

  it("says there is nothing to compare when the address bar names nobody", () => {
    const markup = page([]);
    expect(markup).toContain("Nothing to compare yet");
    expect(markup).not.toContain('class="compare-chart"');
  });

  it("ignores a code the build does not carry", () => {
    const markup = page(["10180", "99999"]);
    expect(markup).toContain("One more metro");
  });

  // the whole point of the second and third encodings: a reader who sees the
  // four hues as two still has a dash and a mark to tell the lines apart
  it("gives every line after the first a dash of its own", () => {
    const markup = page(["10180", "19100", "25980"]);
    expect(markup).toContain(`stroke-dasharray="${DASHES[1]}"`);
    expect(markup).toContain(`stroke-dasharray="${DASHES[2]}"`);
  });

  it("repeats that key in the legend and in the table, so the colour is never alone", () => {
    const markup = page(["10180", "19100"]);
    // one key in the legend chip, one in the table row, for each metro
    expect(markup.split('class="series-key series-0"').length - 1).toBeGreaterThanOrEqual(2);
    expect(markup.split('class="series-key series-1"').length - 1).toBeGreaterThanOrEqual(2);
  });

  it("names every metro in a table with the metric and the index beside it", () => {
    const markup = page(["10180", "19100"]);
    expect(markup).toContain('class="compare-table"');
    expect(markup).toContain("house price index");
    expect(markup).toContain("growth since");
    expect(markup).toContain("<caption");
  });

  it("drops the end labels on a phone, where the gutter would eat the plot", () => {
    expect(page(["10180", "19100"], "wide")).toContain('class="end"');
    expect(page(["10180", "19100"], "phone")).not.toContain('class="end"');
  });

  it("says so when a chosen metro has no price history to draw", () => {
    const markup = bare(["10180", "19100"]);
    expect(markup).toContain("No price history in this build for Abilene, TX");
    expect(markup).toContain("Not enough price history");
  });

  // the key has to come off the line, not off the row: a metro with no line
  // takes no slot, and the metros under it would wear somebody else's key
  it("gives a metro with no line no key, and does not shift the keys under it", () => {
    const markup = bare(["19100", "10180", "25980"]);
    expect(markup).toContain('class="series-key series-0"');
    expect(markup).toContain('class="series-key series-1"');
    expect(markup).not.toContain('class="series-key series-2"');
  });

  it("offers the period control only for a metric that is published at more than one", () => {
    expect(page(["10180", "19100"], "wide", { metric: "income" })).toContain('id="compare-period"');
    // a change over a span has no period to pick
    expect(page(["10180", "19100"], "wide", { metric: "hpi_19_24" })).not.toContain('id="compare-period"');
  });
});

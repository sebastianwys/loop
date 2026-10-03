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

// a withheld rate and a rate nobody measured are different claims, and the
// table cell says which rather than printing the same dash for both
// fhfa's newest year is usually short, and the build carries the index at
// as_of for it rather than a mean of the quarters it has
describe("a partial newest year in the comparison", () => {
  const partial = (metro: Metro, shift: number): Metro => ({
    ...metro,
    series: { hpi: { ...history, as_of: "2026Q2", partial_year: 2026, values: history.values.map((v) => (v === null ? null : v + shift)) } },
  });
  const short = { ...data, metros: [partial(SAMPLE.metros[0], 0), partial(SAMPLE.metros[1], 60), SAMPLE.metros[2]] };
  const markup = render(short, ["10180", "19100"], "wide", {});
  const text = markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("calls its point the index at as_of in the footnote, not an annual mean", () => {
    expect(text).not.toContain("annual mean, the last year through");
    expect(text).toContain("annual mean through 2025, and 2026 is the index at 2026Q2.");
  });

  it("dates the table's last index by the quarter", () => {
    expect(markup).toContain('<span class="date">2026Q2</span>');
    expect(markup).not.toContain('<span class="date">2026</span>');
  });
});

describe("a decade rate the build withheld, in the compare table", () => {
  const blank = (metro: Metro): Metro => ({ ...metro, growth: { ...metro.growth, income_14_24: null } });
  const refused = { ...blank(data.metros[0]), footprint_refused: 0.047 };
  const unmeasured = blank(data.metros[1]);
  const withheldData: MapData = { ...data, metros: [refused, unmeasured, data.metros[2]] };
  const markup = render(withheldData, [refused.cbsa, unmeasured.cbsa], "wide", { metric: "income_14_24" });
  const cell = (name: string) => {
    const rowAt = markup.indexOf(`${name}</span></th>`);
    return markup.slice(rowAt, markup.indexOf("</td>", rowAt));
  };

  it("says withheld for the refused metro, with the reason on the cell", () => {
    expect(cell(refused.name)).toContain("withheld");
    expect(cell(refused.name)).toContain("county lines moved");
  });

  it("keeps the dash for the metro nobody measured", () => {
    expect(cell(unmeasured.name)).not.toContain("withheld");
    expect(cell(unmeasured.name)).toContain(">-");
  });
});

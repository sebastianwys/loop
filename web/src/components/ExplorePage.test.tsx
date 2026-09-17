import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAMPLE } from "../lib/data";
import type { LayoutMode } from "../lib/layout";
import { DEFAULT_ROUTE, type RouteState } from "../lib/route";
import type { Shell } from "../lib/views";
import type { MapData } from "../types";
import { ExplorePage } from "./ExplorePage";

// no dom in this suite, so the markup is read as a string: it proves what a
// reader who cannot see the cloud, or is listening to the page, is given

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

const page = (route: Partial<RouteState> = {}, mode: LayoutMode = "wide", data: MapData = SAMPLE) =>
  renderToStaticMarkup(
    <ExplorePage
      data={data}
      route={{ ...DEFAULT_ROUTE, view: "explore", ...route }}
      go={() => {}}
      viewport={{ width: 1440, height: 900, mode, coarse: false, reducedMotion: false }}
      shell={shell}
    />,
  );

// the y axis comes out of the address bar, which in a node run has to be put there
const atAddress = (search: string, route: Partial<RouteState> = {}) => {
  vi.stubGlobal("window", { location: { search } });
  return page(route);
};

afterEach(() => vi.unstubAllGlobals());

describe("the explore view", () => {
  it("draws one dot per metro on a pair of axes it names to a reader who cannot see them", () => {
    const markup = page();
    expect(markup).toContain('class="explore-chart"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain("HPI growth, 2019 to 2024");
    expect(markup).toContain("Units permitted per 1,000 residents");
  });

  it("opens on a pair that asks a real question rather than on two arbitrary metrics", () => {
    const markup = page();
    expect(markup).toContain('id="explore-x"');
    expect(markup).toContain('id="explore-y"');
    expect(markup).toContain('<option value="permits_per_1000" selected=""');
  });

  it("says how many metros are drawn and which metric the rest are missing", () => {
    const markup = page();
    expect(markup).toContain("2 of 3 metros are drawn");
    expect(markup).toContain("1 has no HPI growth, 2019 to 2024");
  });

  it("says in plain language that the metros are not independent samples and that nothing here is a cause", () => {
    const markup = page();
    expect(markup).toContain("not 410");
    expect(markup).toContain("one national cycle");
    expect(markup).toContain("caused");
  });

  it("gives the cloud a live readout and a way in from the keyboard", () => {
    const markup = page();
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("arrow keys");
  });

  it("puts the ends of both axes in a table, which is what a screen reader can actually read", () => {
    const markup = page();
    expect(markup).toContain('class="explore-table"');
    expect(markup).toContain("highest x");
    expect(markup).toContain("lowest y");
    expect(markup).toContain("Abilene, TX");
    expect(markup).toContain("Dallas-Fort Worth-Arlington, TX");
  });

  it("marks the metro that is open, in the plot and in the table, without leaning on colour", () => {
    const markup = page({ metro: "19100" });
    expect(markup).toContain('class="spot"');
    expect(markup).toContain('class="open"');
    expect(markup).toContain("Dallas");
  });

  it("names every mark in a key, so the plot does not need colour to be read", () => {
    const markup = page();
    expect(markup).toContain("what the marks mean");
    expect(markup).toContain("a division showing its parent metro&#x27;s number");
  });

  it("says there is nothing to draw rather than drawing an empty pair of axes", () => {
    const markup = page({}, "wide", { ...SAMPLE, metros: [] });
    expect(markup).toContain("nothing to draw");
    expect(markup).not.toContain('class="explore-chart"');
    expect(markup).not.toContain('class="explore-table"');
  });

  it("narrows the plot to a phone without dropping the readout or the table", () => {
    const markup = page({}, "phone");
    expect(markup).toContain('width="340"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('class="explore-table"');
  });

  it("takes the second axis from the address bar, so a copied link opens on the pair that was shared", () => {
    const markup = atAddress("?ex_y=inventory&ex_yp=latest", { metric: "permits_units", period: "latest" });
    expect(markup).toContain('<option value="inventory" selected=""');
    expect(markup).toContain("For sale inventory, latest");
  });

  it("draws a division wearing its parent metro's number as a hollow dot and keeps it out of the line", () => {
    const markup = atAddress("?ex_y=inventory&ex_yp=latest", { metric: "permits_units", period: "latest" });
    expect(markup).toContain('class="dot taken"');
    expect(markup).toContain("1 of the dots is hollow");
    expect(markup).toContain("left out of the line");
  });

  it("refuses to fit a line to three metros and says why instead of drawing one", () => {
    const markup = page();
    expect(markup).toContain("no line is drawn");
    expect(markup).not.toContain('class="fit"');
  });
});

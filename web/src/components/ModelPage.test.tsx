import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "../lib/data";
import type { LayoutMode } from "../lib/layout";
import { FIGURE_IDS, FIGURES } from "../lib/modelFigures";
import { DEFAULT_ROUTE } from "../lib/route";
import type { Shell } from "../lib/views";
import type { Latest, MapData, Metro, YearValues } from "../types";
import { ModelPage } from "./ModelPage";

// no dom in this suite, so the markup is read as a string: it proves what a
// reader who cannot see the figures, or is listening to the page, is given

const YEAR: YearValues = {
  hpi: null, income: null, pop: null, age: null, degree_share: null,
  own_rate: null, home_value: null, zhvi: null, zori: null, unemp: null,
};

const LATEST: Latest = {
  zhvi: null, zhvi_date: null, zori: null, zori_date: null, unemp: null, unemp_date: null,
};

function metro(cbsa: string, name: string, latest: Partial<Latest> = {}): Metro {
  return {
    cbsa,
    name,
    lat: 0,
    lon: 0,
    years: { "2014": { ...YEAR }, "2019": { ...YEAR }, "2024": { ...YEAR } },
    latest: { ...LATEST, ...latest },
    growth: { hpi_14_19: null, hpi_19_24: null, income_14_24: null, pop_14_24: null, home_value_14_24: null },
    ptir: { "2014": null, "2019": null, "2024": null },
  };
}

const forecast = (cbsa: string, name: string, near: number, span: number, error: number) =>
  metro(cbsa, name, {
    hpi_forecast_4q: near,
    hpi_forecast_4q_date: "2026-06",
    hpi_forecast_4q_lo: near - span / 2,
    hpi_forecast_4q_hi: near + span / 2,
    hpi_forecast_8q: near * 2,
    hpi_forecast_8q_date: "2026-06",
    hpi_index_error: error,
  });

const METROS = [
  forecast("10180", "Abilene, TX", 1, 19, 2.4),
  forecast("19100", "Dallas-Fort Worth-Arlington, TX", 4, 20, 0.12),
  forecast("34620", "Muncie, IN", 5, 21, 0.9),
  forecast("29020", "Kokomo, IN", 6, 22, 3.1),
  forecast("23420", "Fresno, CA", 9, 20, 0.08),
];

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

const render = (metros: Metro[], mode: LayoutMode = "wide") =>
  renderToStaticMarkup(
    <ModelPage
      data={{ ...SAMPLE, metros } as MapData}
      route={{ ...DEFAULT_ROUTE, view: "model" }}
      go={() => {}}
      viewport={{ width: 1440, height: 900, mode, coarse: false, reducedMotion: false }}
      shell={shell}
    />,
  );

const page = render(METROS);

describe("the model view", () => {
  it("opens with what the model is asked and what it costs to believe it", () => {
    expect(page).toContain("How the forecast is built and judged");
    expect(page).toContain("band coverage at eight quarters");
    expect(page).toContain("and that is a miss");
  });

  it("follows the walkthrough: the panel, the design, the models, the results, the forecast, the limits", () => {
    for (const heading of [
      "The panel", "The evaluation design", "The models", "The results", "The shipped forecast", "The limits",
    ]) {
      expect(page, heading).toContain(heading);
    }
  });

  it("publishes the leaderboard as a table with a header on every column and every row", () => {
    expect(page).toContain('<caption>');
    expect(page).toContain('<th scope="col">model</th>');
    expect(page).toContain('<th scope="col" class="v">8 quarters</th>');
    expect(page).toContain('<th scope="row">sequence gru');
    expect(page).toContain("on the map");
  });

  it("marks the lowest error in a column in words as well as in weight", () => {
    expect(page).toContain("lowest error at this horizon");
  });

  it("gives the reader every published number for a model, not just its error", () => {
    // the sequence gru at eight quarters: error, coverage and band width
    expect(page).toContain("10.15");
    expect(page).toContain("cover 0.66, width 0.208");
  });

  it("says out loud that ridge beats the shipped model at the short horizons", () => {
    expect(page).toContain("ridge is ahead at one quarter by 0.12 points and at two quarters by 0.08 points");
    expect(page).toContain("It loses the short horizons");
    expect(page).toContain("Ridge is ahead at one quarter");
  });

  it("names the nearest rival at eight quarters and how thin the win is", () => {
    expect(page).toContain("ridge");
    expect(page).toContain("0.25 points");
    // the size is given against the error rather than called thin or fat
    expect(page).toContain("percent of the error it sits inside");
  });

  it("puts the coverage miss in the limits rather than in a footnote", () => {
    expect(page).toContain("The bands fail at eight quarters");
    expect(page).toContain("0.66 of outcomes there against a nominal 0.90");
    expect(page).toContain("which is leakage, so it is reported rather than repaired");
  });

  it("reads the shipped forecast off the map data rather than repeating a write-up", () => {
    // the five metros above have a median of +5.0 and a weakest of +1.0
    expect(page).toContain("median four quarter forecast across 5 metros is +5.0%");
    expect(page).toContain("the weakest metro is Abilene, TX at +1.0%");
    expect(page).toContain("The eight quarter median is +10.0%");
  });

  // "positive everywhere" is a claim about this export, not a fixed line
  it("counts the metros forecast to fall rather than claiming the model is positive everywhere", () => {
    const falling = render([...METROS, forecast("33700", "Modesto, CA", -2, 18, 1)]);
    expect(falling).toContain("One of them is forecast to fall, the weakest Modesto, CA at -2.0%");
    expect(falling).not.toContain("It is positive everywhere");
    expect(page).toContain("It is positive everywhere");
  });

  it("shows how wide the widest and narrowest bands on the map really are", () => {
    expect(page).toContain("narrowest four quarter band on the map belongs to Abilene, TX");
    expect(page).toContain("The widest belongs to Kokomo, IN");
  });

  it("credits the index error to FHFA and names both ends of it", () => {
    expect(page).toContain("credited to FHFA");
    expect(page).toContain("0.08 percent in Fresno, CA");
    expect(page).toContain("3.1 percent in Kokomo, IN");
  });

  it("lazy loads every figure at a declared size, with alt text that says what it shows", () => {
    for (const id of FIGURE_IDS) {
      const figure = FIGURES[id];
      expect(page, figure.file).toContain(`src="/figures/${figure.file}"`);
      expect(page, figure.file).toContain(`width="${figure.width}"`);
      expect(page, figure.file).toContain(`height="${figure.height}"`);
      expect(page, figure.file).toContain(figure.alt.slice(0, 40));
    }
    expect(page.split('loading="lazy"')).toHaveLength(FIGURE_IDS.length + 1);
  });

  it("prints no gaps where a number was missing", () => {
    expect(page).not.toContain("undefined");
    expect(page).not.toContain("NaN");
    // a value that came back empty would land as its own word in the prose
    expect(page).not.toMatch(/>\s*null|\snull[.,%]/);
  });

  it("still stands up on a build whose metros carry no forecast at all", () => {
    const bare = render([metro("10180", "Abilene, TX")]);
    expect(bare).toContain("The limits");
    expect(bare).toContain("0.66 of outcomes there against a nominal 0.90");
    expect(bare).not.toContain("undefined");
    expect(bare).not.toContain("NaN");
  });
});

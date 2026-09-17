import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "../lib/data";
import type { LayoutMode } from "../lib/layout";
import { DEFAULT_ROUTE } from "../lib/route";
import type { Shell } from "../lib/views";
import type { Latest, MapData, Metro, YearValues } from "../types";
import { AccuracyPage } from "./AccuracyPage";

// no dom in this suite, so the markup is read as a string: it proves what a
// reader who cannot see the charts, or is listening to the page, is given

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

// a scored metro with a live call behind it, the shape the real build carries
const scored = (cbsa: string, name: string, realized: number, surprise: number, error: number | null) =>
  metro(cbsa, name, {
    hpi_yoy_latest: realized,
    hpi_surprise_4q: surprise,
    hpi_surprise_4q_date: "2026-06",
    hpi_forecast_4q: 5,
    hpi_forecast_4q_lo: -4,
    hpi_forecast_4q_hi: 15,
    hpi_forecast_8q: 11,
    ...(error === null ? {} : { hpi_index_error: error }),
  });

// thirteen metros the model mostly overshot, in three states, so the bias,
// the state grouping and the four error bins all have something to work with
const SCORED = [
  scored("10180", "Abilene, TX", 2, -1, 0.2),
  scored("19100", "Dallas-Fort Worth-Arlington, TX", 1, -3, 0.3),
  scored("11100", "Amarillo, TX", 3, -2, 0.4),
  scored("12420", "Austin-Round Rock, TX", 0.5, -4.5, 0.55),
  scored("23420", "Fresno, CA", 4, 1, 0.6),
  scored("12540", "Bakersfield, CA", 6, 3, 0.75),
  scored("33700", "Modesto, CA", -1, -5, 0.9),
  scored("44700", "Stockton, CA", 2, -2.5, 1.2),
  scored("34620", "Muncie, IN", 9, 6, 2.1),
  scored("29020", "Kokomo, IN", -3, -8, 2.8),
  scored("21140", "Elkhart-Goshen, IN", 1, -1.5, 1.6),
  scored("47380", "Waco, TX", 2.5, -1.8, 0.45),
  scored("32900", "Merced, CA", 0, -3.5, 1.05),
];

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

const render = (metros: Metro[], mode: LayoutMode = "wide") =>
  renderToStaticMarkup(
    <AccuracyPage
      data={{ ...SAMPLE, metros } as MapData}
      route={{ ...DEFAULT_ROUTE, view: "accuracy" }}
      go={() => {}}
      viewport={{ width: 1440, height: 900, mode, coarse: false, reducedMotion: false }}
      shell={shell}
    />,
  );

const page = render(SCORED);

describe("the accuracy view", () => {
  it("leads with a scorecard saying how many calls were scored and how big the typical miss was", () => {
    expect(page).toContain('class="acc-tiles"');
    expect(page).toContain("calls scored");
    expect(page).toContain("typical miss");
    expect(page).toContain(`of ${SCORED.length} metros`);
  });

  it("says plainly which way the model leaned rather than leaving the reader to work it out", () => {
    expect(page).toContain("That is a bias, not bad luck in a few places");
    expect(page).toContain("The model ran high, nearly everywhere at once");
    expect(page).toContain("came in under");
  });

  it("names the biggest miss in each direction with the realized and expected growth beside it", () => {
    // kokomo is the worst overshoot: it fell 3.0 percent against a call of 5.0
    expect(page).toContain("Kokomo, IN");
    expect(page).toContain("-3.0%");
    expect(page).toContain("+5.0%");
    expect(page).toContain("-8.0 pp");
    // and muncie is the other direction, up 9.0 against a call of 3.0
    expect(page).toContain("Muncie, IN");
    expect(page).toContain("+6.0 pp");
  });

  it("keeps the growth rates in percent and the miss in percentage points, so the two units never blur", () => {
    expect(page).toContain(" pp");
    expect(page).toContain("percentage points");
    expect(page).toContain("it grew");
    expect(page).toContain("model said");
  });

  it("never counts a metro with no surprise as a miss of zero", () => {
    const withBlank = render([...SCORED, metro("99999", "Nowhere, ZZ", { hpi_yoy_latest: 4 })]);
    // twelve metros in the build, eleven of them scored
    expect(withBlank).toContain(`of ${SCORED.length + 1} metros`);
    expect(withBlank).toContain(`${SCORED.length} of ${SCORED.length + 1} metros carry a scored call`);
    expect(withBlank).toContain("the other 1 are not counted anywhere on this page");
  });

  it("draws an empty state rather than a page of broken numbers when nothing was scored", () => {
    const empty = render([]);
    expect(empty).toContain("No scored forecasts in this build");
    expect(empty).not.toContain("NaN");
    expect(empty).not.toContain("acc-tiles");
  });

  it("survives a metro whose every latest field is null", () => {
    const blank = metro("99999", "Nowhere, ZZ", {
      hpi_surprise_4q: null, hpi_yoy_latest: null, hpi_index_error: null,
      hpi_forecast_4q: null, hpi_forecast_4q_lo: null, hpi_forecast_4q_hi: null, hpi_forecast_8q: null,
    });
    expect(render([blank])).toContain("No scored forecasts in this build");
    expect(render([...SCORED, blank])).not.toContain("NaN");
  });

  it("gives every table a caption and real header cells", () => {
    const tables = page.split("<table").length - 1;
    expect(tables).toBeGreaterThanOrEqual(4);
    expect(page.split("<caption").length - 1).toBe(tables);
    expect(page).toContain('scope="col"');
    expect(page).toContain('scope="row"');
  });

  it("names both directions of the histogram in words, so its colours are never the only reading", () => {
    expect(page).toContain("model ran high");
    expect(page).toContain("model ran low");
    expect(page).toContain("0, the model was right");
    // and the same distribution is repeated as numbers underneath
    expect(page).toContain("The same distribution as numbers");
  });

  it("gives both charts a label a screen reader can use in place of the picture", () => {
    expect(page).toContain('role="img"');
    // an apostrophe arrives html escaped, so the assertions read around it
    expect(page).toContain("how far the model");
    expect(page).toContain("last scored call missed in each of");
    expect(page).toContain("the size of the miss against fhfa");
    expect(page).toContain("standard error for the index");
  });

  it("offers every named metro as a button, so a big miss opens on the map", () => {
    expect(page).toContain('class="acc-link"');
    expect(page).toContain('<button type="button" class="acc-link">Kokomo, IN</button>');
  });

  it("reports the relationship with the index error as measured, and refuses to call it a cause", () => {
    expect(page).toContain("index standard error");
    expect(page).toContain("correlation");
    expect(page).toContain("not a mechanism");
    expect(page).toContain("does not say a loose index causes a bad forecast");
    expect(page).toContain("rank correlation");
  });

  it("says the metros are not independent draws and backs it with the state grouping", () => {
    expect(page).toContain("not independent");
    expect(page).toContain("share one national housing cycle");
    expect(page).toContain("Average miss by state");
    expect(page).toContain("one origin quarter");
  });

  it("reads the live forecast against the scorecard rather than on its own", () => {
    expect(page).toContain("The live call is");
    expect(page).toContain("90 percent interval");
    expect(page).toContain("not a correction anyone should apply");
  });

  it("drops the index error section when the build carries no standard errors", () => {
    const bare = render(SCORED.map((m) => metro(m.cbsa, m.name, { ...m.latest, hpi_index_error: null })));
    expect(bare).toContain("nothing to test the miss against");
    expect(bare).not.toContain("rank correlation");
    // the rest of the page still stands
    expect(bare).toContain("That is a bias, not bad luck in a few places");
  });

  it("names the origin the calls were scored at, and the source they are scored against", () => {
    expect(page).toContain("Source: Loop model");
    expect(page).toContain("origin Jun 2026");
    expect(page).toContain("FHFA House Price Index");
  });

  it("renders at a phone width with the same tables and charts", () => {
    const phone = render(SCORED, "phone");
    expect(phone).toContain('class="acc-scroll"');
    expect(phone).toContain("<table");
    expect(phone).toContain('class="acc-chart acc-hist"');
  });

  it("puts no character outside ascii into the page, at any width", () => {
    for (const mode of ["phone", "wide"] as const) {
      // eslint control characters aside, every byte a reader sees is plain ascii
      expect(render(SCORED, mode), mode).toMatch(/^[\x20-\x7e\n\r\t]*$/);
    }
  });
});

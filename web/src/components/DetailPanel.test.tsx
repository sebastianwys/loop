import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "../lib/data";
import { DetailPanel, historyNote } from "./DetailPanel";
import { HistoryChart } from "./HistoryChart";
import type { AnnualSeries, Metro } from "../types";

// no dom in this suite, so the markup is read as a string
const html = (node: ReactElement) => renderToStaticMarkup(node);
const metro = (cbsa: string) => SAMPLE.metros.find((m) => m.cbsa === cbsa)!;
const panel = (cbsa: string) => html(<DetailPanel metro={metro(cbsa)} metros={SAMPLE.metros} onClose={() => {}} />);

describe("a number the metro took from its parent", () => {
  // the footer note names the whole set, but a reader looking at one row sees
  // a figure with nothing on it. the mark belongs beside the number
  it("marks the row, not just the footer", () => {
    const markup = panel("25980");
    // the division inherits permits_units and inventory from abilene
    expect(markup).toContain("From the parent metro");
    // and each inherited row says so where the number is
    const marks = markup.split("from the parent").length - 1;
    expect(marks).toBeGreaterThanOrEqual(1);
  });

  it("leaves a metro's own numbers unmarked", () => {
    const markup = panel("10180");
    expect(markup).not.toContain("from the parent");
    expect(markup).not.toContain("From the parent metro");
  });

  // zillow's series ride on zillow_scope, not parent_metrics. an unmarked row
  // has to mean "this metro measured it", so both mechanisms mark
  it("marks a zillow series a division took whole", () => {
    const taken = { ...metro("25980"), zillow_scope: "parent metro" as const };
    const markup = html(<DetailPanel metro={taken} metros={SAMPLE.metros} onClose={() => {}} />);
    expect(markup).toContain("Zillow values are for the parent metro");
    expect(markup.split("from the parent").length - 1).toBeGreaterThan(1);
  });

  // the row mark stays short; the header line and the footer note are where
  // the parent is named, so the measure column does not wrap to seven lines
  it("names the parent elsewhere in the panel", () => {
    const markup = panel("25980");
    expect(markup).toContain("Abilene, TX");
    expect(markup).toContain("From the parent metro: ");
  });
});

// the last point used to be a mean of however much of the year had been
// published, drawn on a line of full-year means and labelled as that year
describe("the note under the price history", () => {
  const full: AnnualSeries = { start: 2000, values: [100, 110], as_of: "2001Q4", partial_year: null };
  const short: AnnualSeries = { start: 2000, values: [100, 112], as_of: "2001Q2", partial_year: 2001 };

  it("says the last point is a quarter when the year is short", () => {
    const note = historyNote(short, false);
    expect(note).toContain("through 2000");
    expect(note).toContain("the index at 2001Q2");
    expect(note).toContain("not a full year");
  });

  it("says nothing about quarters when the year is complete", () => {
    const note = historyNote(full, false);
    expect(note).toBe("Annual mean of the index, through 2001.");
  });

  it("keeps the forecast sentence either way", () => {
    expect(historyNote(short, true)).toContain("90 percent band");
    expect(historyNote(full, true)).toContain("90 percent band");
  });

  // the chart's accessible name and its last dot say what the note says
  it("is what the chart's title and last dot say too", () => {
    const chart = html(<HistoryChart series={short} forecast={null} name="Abilene, TX" />);
    const title = /aria-label="([^"]*)"/.exec(chart)?.[1] ?? "";
    expect(title).toBe("house price index for Abilene, TX, annual mean 2000 to 2000, then the index at 2001Q2");
    expect(chart).toContain("<title>2001: 112.0, the index at 2001Q2</title>");
    const whole = html(<HistoryChart series={full} forecast={null} name="Abilene, TX" />);
    expect(whole).toContain("annual mean 2000 to 2001, the last through 2001Q4");
  });
});

// the index standard error belongs beside the forecast it qualifies, and the
// Forecasts section is the only place in the panel that can put it there
describe("the index standard error", () => {
  const withError = (error: number | null): Metro => ({ ...metro("10180"), latest: { ...metro("10180").latest, hpi_index_error: error } });

  it("sits in the Forecasts table, credited to fhfa", () => {
    const markup = html(<DetailPanel metro={withError(1.84)} metros={SAMPLE.metros} onClose={() => {}} />);
    const forecasts = markup.slice(markup.indexOf("Forecasts"));
    expect(forecasts).toContain("Index standard error");
    expect(forecasts).toContain("FHFA, percent of the index");
    // fhfa sets it in hundredths, and so does every page that prints it
    expect(forecasts).toContain("1.84%");
  });

  it("is left out for a metro that carries none", () => {
    const markup = html(<DetailPanel metro={withError(null)} metros={SAMPLE.metros} onClose={() => {}} />);
    expect(markup).not.toContain("Index standard error");
  });
});

// realized growth rides in the model's export but is what the fhfa index did,
// so its rows in the Forecasts table name fhfa, and the model's lines do not
describe("realized growth in the Forecasts table", () => {
  it("is credited to fhfa on its own rows", () => {
    const forecasts = panel("10180").slice(panel("10180").indexOf("<h3>Forecasts"));
    expect(forecasts).toContain('HPI growth, last 4 quarters<span class="date">FHFA</span>');
    expect(forecasts).toContain('HPI growth, 5 year annualized<span class="date">FHFA</span>');
    expect(forecasts).not.toContain('next 4 quarters<span class="date">FHFA</span>');
  });
});

// a withheld rate is a different claim from one nobody measured, so its cell
// says so, and the note under the table says why
describe("a decade rate the build withheld", () => {
  const base = metro("10180");
  const blank = { ...base.growth, income_14_24: null, pop_14_24: null, home_value_14_24: null };

  it("reads withheld in the Change table when the county lines moved too far", () => {
    const refused: Metro = { ...base, growth: blank, footprint_refused: 0.047 };
    const markup = html(<DetailPanel metro={refused} metros={SAMPLE.metros} onClose={() => {}} />);
    const change = markup.slice(markup.indexOf("<h3>Change</h3>"), markup.indexOf("geo-note", markup.indexOf("<h3>Change</h3>")));
    expect(change.split('class="withheld"').length - 1).toBe(3);
    expect(markup).toContain("withheld rather than measured");
  });

  it("keeps the plain dash for a rate nobody measured", () => {
    const unmeasured: Metro = { ...base, growth: blank };
    const markup = html(<DetailPanel metro={unmeasured} metros={SAMPLE.metros} onClose={() => {}} />);
    expect(markup).not.toContain("withheld");
  });

  it("says a move nobody could weigh is withheld too, without a share", () => {
    const unweighed: Metro = { ...base, growth: blank, footprint_unweighed: true };
    const markup = html(<DetailPanel metro={unweighed} metros={SAMPLE.metros} onClose={() => {}} />);
    expect(markup).toContain("could not be weighed");
    expect(markup).not.toContain("100.00 percent");
  });
});

// the trend in a vintage table reads its values out, for a screen reader and
// on hover. a year the build withheld reads withheld there too, as its cell
// does, rather than the dash a year nobody measured gets
describe("a permit rate the build withheld, in the vintage table's trend", () => {
  const base = metro("10180");
  const trend = (m: Metro) => {
    const markup = html(<DetailPanel metro={m} metros={[m, ...SAMPLE.metros.slice(1)]} onClose={() => {}} />);
    const at = markup.indexOf("Units permitted per 1,000 residents");
    return /aria-label="([^"]*)"/.exec(markup.slice(at, markup.indexOf("</tr>", at)))?.[1] ?? null;
  };

  it("says withheld for the year whose permits and people were counted over different counties", () => {
    const marked: Metro = { ...base, years: { ...base.years, "2014": { ...base.years["2014"], permits_footprint: 0.378 } } };
    expect(trend(marked)).toMatch(/^2014 withheld, 2019 \d/);
  });

  it("keeps the plain dash for a year nobody measured", () => {
    const unmeasured: Metro = { ...base, years: { ...base.years, "2014": { ...base.years["2014"], permits_units: null } } };
    expect(trend(unmeasured)).toMatch(/^2014 -, 2019 \d/);
  });
});

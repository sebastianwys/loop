import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "../lib/data";
import { DEFAULT_ROUTE } from "../lib/route";
import type { Shell } from "../lib/views";
import type { MapData, Provenance } from "../types";
import { SourcesPage } from "./SourcesPage";

// no dom in this suite, so the markup is read as a string: it proves what a
// reader who is listening to the page, or checking it against the repo, is given

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

const FHFA_SHA = "f7eca3f886f0bf58d59554df9dfea6e500642148ce473d1e0ac81fd92fc4cc86";

const entry = (over: Partial<Provenance>): Provenance => ({
  source: "fhfa",
  provider: "Federal Housing Finance Agency (FHFA)",
  url: "https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv",
  version: "2026-Q2",
  downloaded_at: "2026-09-14T23:12:19Z",
  files: 2,
  row_count: 244231,
  filename: "hpi_master.csv",
  sha256: FHFA_SHA,
  ...over,
});

const PROVENANCE: Provenance[] = [
  entry({}),
  entry({
    source: "gazetteer", provider: "U.S. Census Bureau", version: "2024 Gazetteer",
    url: "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_cbsa_national.zip",
    files: 2, row_count: 3026, filename: "cbsa_centroids.csv",
    sha256: "031fdd07d3bc39a321530d1b58a2b4160db822addd3af4bd933b9512d5aafcce",
  }),
  entry({
    source: "zillow", provider: "Zillow Research", version: "through 2026-08-31",
    url: "https://files.zillowstatic.com/research/public_csvs/zhvi/Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
    files: 2, row_count: 1645, filename: "zhvi_metro.csv",
    sha256: "d4b5d78b88dbd08a9b83129a876de5190e1fce8b720dcec2e3b4944fe222b877",
  }),
  entry({
    source: "zillow_extras", provider: "Zillow Research", version: "through 2026-08-31",
    url: "https://www.zillow.com/research/data/", files: 1, row_count: 23550, filename: "metrics.csv",
    sha256: "b5091797fad5076c9963e8b7370796129e70f6e6aa5539a3f2c1d0b71db1a41f",
  }),
  // the one source computed here rather than fetched. its address is the code
  // that wrote the file, so the page has nothing to link and must not pretend
  entry({
    source: "forecast", provider: "Loop forecasting model", version: "gru, origin 2026Q2",
    url: "loop.export", files: 1, row_count: 4100, filename: "metrics.csv",
    sha256: "b2573c00154a7d909b1105a1ea068517970241028956c26635e278ae97685e06",
  }),
];

const render = (data: MapData) =>
  renderToStaticMarkup(
    <SourcesPage
      data={data}
      route={{ ...DEFAULT_ROUTE, view: "sources" }}
      go={() => {}}
      viewport={{ width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false }}
      shell={shell}
    />,
  );

const page = render({ ...SAMPLE, provenance: PROVENANCE });

describe("the sources view", () => {
  it("draws the downloads as a table with a column and a row heading on every cell", () => {
    expect(page).toContain("<table");
    expect(page).toContain('<th scope="col">');
    expect(page).toContain('<th scope="row">');
    expect(page).toContain("<caption");
  });

  it("names the publisher, the vintage, the moment of the download and the size", () => {
    expect(page).toContain("Federal Housing Finance Agency (FHFA)");
    expect(page).toContain("2026-Q2");
    expect(page).toContain("2026-09-14 23:12 UTC");
    expect(page).toContain("244,231");
  });

  it("links the upstream address a reader would check the download against", () => {
    expect(page).toContain('href="https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv"');
  });

  it("truncates the checksums rather than printing sixteen lines of hex", () => {
    expect(page).toContain("f7eca3f886f0...");
    expect(page).not.toContain(FHFA_SHA);
  });

  it("offers the whole of every checksum, and a copy of any one of them", () => {
    expect(page).toContain("show the full checksums");
    expect(page).toContain("copy the sha256 of fhfa/hpi_master.csv");
  });

  it("names the metrics a source builds, one list item each, since the labels carry commas", () => {
    expect(page).toContain("<li>House price index</li>");
    expect(page).toContain("<li>For sale inventory</li>");
  });

  it("says what a folder does when it builds no metric, rather than leaving it blank", () => {
    expect(page).toContain("the centroid each metro&#x27;s dot is placed at");
  });

  it("splits the two zillow folders by the file each metric was read out of", () => {
    const feeds = page.slice(page.indexOf("what it builds"));
    const cut = feeds.indexOf("zillow_extras");
    // the value index is in the main folder and the market fields in the
    // extras csv, so neither folder may claim the other's numbers
    expect(feeds.slice(0, cut)).toContain("Zillow home value index");
    expect(feeds.slice(0, cut)).not.toContain("For sale inventory");
    expect(feeds.slice(cut)).toContain("For sale inventory");
    expect(feeds.slice(cut)).not.toContain("Zillow home value index");
  });

  it("says the forecast is computed here and points at the manifest it writes", () => {
    expect(page).toContain("The forecast is computed here, not downloaded");
    expect(page).toContain("ml/results/forecast/download_manifest.json");
    expect(page).toContain("gru, origin 2026Q2");
  });

  it("gives the model's export a row of its own, with the code that wrote it as the address", () => {
    const tables = page.slice(0, page.indexOf("sources-model"));
    expect(tables).toContain("Loop forecasting model");
    expect(tables).toContain("b2573c00154a");
    // an address that is not an http url is text, never a link a reader can follow
    expect(tables).toContain("<code class=\"url\">loop.export</code>");
    expect(tables).not.toContain("href=\"loop.export\"");
    // and the metrics it builds are named under it, like every other folder
    expect(tables).toContain("Expected HPI growth, next 4 quarters");
  });

  it("credits the index standard error to the publisher it belongs to, not to the model", () => {
    expect(page).toContain("The index standard error is FHFA&#x27;s own");
    const model = page.slice(page.indexOf("sources-model"));
    expect(model).not.toContain("<li>Index standard error</li>");
  });

  it("counts the folders that build nothing rather than printing a number that can go stale", () => {
    expect(page).toContain("One folder builds no metric at all");
    expect(page).toContain("More than one folder feeds zillow here");
  });

  it("tells a reader where the files are in the repository, not on anybody's disk", () => {
    expect(page).toContain("under data/raw");
    expect(page).not.toContain("/Users/");
  });

  it("says so plainly when a build carries no provenance at all", () => {
    const bare = render(SAMPLE);
    expect(SAMPLE.provenance).toBeUndefined();
    expect(bare).toContain("carries no provenance block");
    expect(bare).not.toContain("show the full checksums");
    // the vintages it does have are still worth showing
    expect(bare).toContain("2024 Gazetteer");
  });

  it("never renders a credential a manifest might carry", () => {
    const leaky = render({
      ...SAMPLE,
      provenance: [entry({ source: "bea", url: "https://apps.bea.gov/api/data?UserID=deadbeef&TableName=CAINC1" })],
    });
    expect(leaky).not.toContain("deadbeef");
    expect(leaky).toContain("UserID removed before this was shown");
    expect(leaky).toContain("TableName=CAINC1");
  });

  it("will not turn a url that is not an address into a link", () => {
    const hostile = render({ ...SAMPLE, provenance: [entry({ url: "javascript:alert(1)" })] });
    expect(hostile).not.toContain('href="javascript');
  });
});

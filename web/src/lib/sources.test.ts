import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "./data";
import { DEFS, SOURCE_LABEL, visibleDefs, type Source } from "./metrics";
import { buildSources, metricsOf, safeUrl, shortHash, sourceOf, stamp } from "./sources";
import type { MapData, Provenance } from "../types";

const entry = (over: Partial<Provenance>): Provenance => ({
  source: "fhfa",
  provider: "Federal Housing Finance Agency (FHFA)",
  url: "https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv",
  version: "2026-Q2",
  downloaded_at: "2026-09-14T23:12:19Z",
  files: 2,
  row_count: 244231,
  filename: "hpi_master.csv",
  sha256: "f7eca3f886f0bf58d59554df9dfea6e500642148ce473d1e0ac81fd92fc4cc86",
  ...over,
});

const withProvenance = (rows: Provenance[]): MapData => ({ ...SAMPLE, provenance: rows });

describe("sourceOf", () => {
  it("takes a folder named after a source id to that id", () => {
    expect(sourceOf("fhfa")).toBe("fhfa");
    expect(sourceOf("acs")).toBe("acs");
    expect(sourceOf("census")).toBe("census");
  });

  it("takes the zillow extras folder to the zillow id the two folders share", () => {
    expect(sourceOf("zillow_extras")).toBe("zillow");
  });

  it("has no source id for a folder the site reads no metric out of", () => {
    expect(sourceOf("boundaries")).toBeNull();
    expect(sourceOf("gazetteer")).toBeNull();
    expect(sourceOf("national")).toBeNull();
  });

  it("does not mistake an inherited object property for a source id", () => {
    expect(sourceOf("toString")).toBeNull();
    expect(sourceOf("constructor")).toBeNull();
  });
});

describe("metricsOf", () => {
  it("gives a folder the metrics whose definitions name its source", () => {
    const ids = metricsOf("irs", DEFS).map((d) => d.id);
    expect(ids).toContain("irs_net_returns");
    expect(ids).not.toContain("unemp");
  });

  it("splits the zillow metrics between the two zillow folders with nothing in both", () => {
    const main = metricsOf("zillow", DEFS).map((d) => d.id);
    const extras = metricsOf("zillow_extras", DEFS).map((d) => d.id);
    expect(main).toEqual(["zhvi", "zori"]);
    expect(extras).toEqual(["zhvf_forecast", "inventory", "days_to_pending", "price_cut_share"]);
    expect(main.filter((id) => extras.includes(id))).toEqual([]);
    const both = new Set([...main, ...extras]);
    expect(both.size).toBe(DEFS.filter((d) => d.source === "zillow").length);
  });

  it("gives no metrics to a folder that feeds the map or the header rather than a metric", () => {
    expect(metricsOf("boundaries", DEFS)).toEqual([]);
    expect(metricsOf("gazetteer", DEFS)).toEqual([]);
    expect(metricsOf("fred", DEFS)).toEqual([]);
    expect(metricsOf("national", DEFS)).toEqual([]);
  });
});

describe("buildSources", () => {
  it("returns no rows for a build made before the provenance block existed", () => {
    const report = buildSources(SAMPLE);
    expect(SAMPLE.provenance).toBeUndefined();
    expect(report.rows).toEqual([]);
    expect(report.files).toBe(0);
    expect(report.rowCount).toBe(0);
    expect(report.oldest).toBeNull();
  });

  it("survives no data at all", () => {
    expect(buildSources(null).rows).toEqual([]);
    expect(buildSources(undefined).rows).toEqual([]);
  });

  // the provenance row is evidence the bytes landed. the vintage line beside it
  // is evidence this build read them, and goes null where it read nothing. the
  // page printed both with nothing tying them together, so a reader met a
  // vintage in one table and a blank in the other and had to pick one
  it("marks a row whose vintage line this build could not fill", () => {
    const data = { ...withProvenance([entry({}), entry({ source: "census" })]),
                   sources: { fhfa: null, census: "ACS 5-year 2024" } } as unknown as MapData;
    const rows = buildSources(data).rows;
    expect(rows.find((r) => r.entry.source === "fhfa")?.read).toBe(false);
    expect(rows.find((r) => r.entry.source === "census")?.read).toBe(true);
    // and the landing record is untouched, which is what the table is for
    expect(rows.find((r) => r.entry.source === "fhfa")?.entry.version).toBe("2026-Q2");
  });

  // a build with no vintage line, or one that does not name the folder, cannot
  // support either claim and makes neither
  it("says nothing about a build that carries no vintage line", () => {
    const data = { ...withProvenance([entry({})]), sources: undefined } as unknown as MapData;
    expect(buildSources(data).rows[0].read).toBeNull();
    const partial = { ...withProvenance([entry({})]), sources: { census: "ACS" } } as unknown as MapData;
    expect(buildSources(partial).rows[0].read).toBeNull();
  });

  it("sorts the rows by folder name so the page does not reorder between builds", () => {
    const report = buildSources(withProvenance([entry({ source: "zillow" }), entry({ source: "acs" }), entry({ source: "irs" })]));
    expect(report.rows.map((r) => r.entry.source)).toEqual(["acs", "irs", "zillow"]);
  });

  it("totals the files and the rows across every folder", () => {
    const report = buildSources(withProvenance([
      entry({ source: "fhfa", files: 2, row_count: 100 }),
      entry({ source: "irs", files: 1, row_count: 40 }),
    ]));
    expect(report.files).toBe(3);
    expect(report.rowCount).toBe(140);
  });

  it("names the first and the last download so the reader knows how old the build is", () => {
    const report = buildSources(withProvenance([
      entry({ source: "fhfa", downloaded_at: "2026-09-14T23:12:19Z" }),
      entry({ source: "irs", downloaded_at: "2026-09-17T04:45:09Z" }),
      entry({ source: "pep", downloaded_at: "2026-09-15T19:53:57Z" }),
    ]));
    expect(report.oldest).toBe("2026-09-14T23:12:19Z");
    expect(report.newest).toBe("2026-09-17T04:45:09Z");
  });

  it("explains a folder that builds no metric rather than leaving the cell empty", () => {
    const report = buildSources(withProvenance([entry({ source: "gazetteer" })]));
    expect(report.rows[0].metrics).toEqual([]);
    expect(report.rows[0].role).toContain("centroid");
    expect(report.rows[0].source).toBeNull();
    expect(report.rows[0].label).toBeNull();
  });

  it("carries the site's display name for a folder that does build metrics", () => {
    const report = buildSources(withProvenance([entry({ source: "pep" })]));
    expect(report.rows[0].label).toBe(SOURCE_LABEL.pep);
    expect(report.rows[0].role).toBeNull();
    expect(report.rows[0].metrics.length).toBeGreaterThan(0);
  });

  it("lists a source that carries metrics but no folder, which is how the model reads", () => {
    const folders = [...new Set(DEFS.map((d) => d.source))].filter((s) => s !== "forecast");
    const report = buildSources(withProvenance(folders.map((source) => entry({ source }))));
    expect(report.unsourced).toEqual(["forecast"]);
  });

  it("only counts a source as unsourced when this build shows a metric from it", () => {
    // nothing downloaded, so every source with a visible metric is missing one
    const report = buildSources(withProvenance([]));
    const visible = new Set(visibleDefs(SAMPLE.metros).map((d) => d.source));
    expect(new Set(report.unsourced)).toEqual(visible);
    // fred publishes the mortgage rate, not a metric, so it is never in here
    expect(report.unsourced).not.toContain("fred");
  });
});

describe("safeUrl", () => {
  it("leaves a public endpoint exactly as the manifest recorded it", () => {
    const url = "https://www2.census.gov/econ/bps/CBSA%20(beginning%20Jan%202024)/";
    const safe = safeUrl(url);
    expect(safe.text).toBe(url);
    expect(safe.href).toBe(url);
    expect(safe.stripped).toEqual([]);
  });

  it("keeps the query parameters that describe the request", () => {
    const url = "https://api.stlouisfed.org/fred/series/observations?series_id=MORTGAGE30US";
    expect(safeUrl(url).text).toBe(url);
    expect(safeUrl(url).stripped).toEqual([]);
  });

  it("strips a query parameter that reads like a credential and says which", () => {
    const safe = safeUrl("https://api.stlouisfed.org/fred/series/observations?series_id=GDP&api_key=deadbeef");
    expect(safe.text).toBe("https://api.stlouisfed.org/fred/series/observations?series_id=GDP");
    expect(safe.stripped).toEqual(["api_key"]);
    expect(safe.text).not.toContain("deadbeef");
  });

  it("strips the parameter even when it is the only one, leaving a bare path", () => {
    const safe = safeUrl("https://apps.bea.gov/api/data?UserID=secret-value");
    expect(safe.text).toBe("https://apps.bea.gov/api/data");
    expect(safe.stripped).toEqual(["UserID"]);
  });

  it("strips every credential shaped parameter, not just the first", () => {
    const safe = safeUrl("https://example.gov/x?key=a&page=2&token=b");
    expect(safe.text).toBe("https://example.gov/x?page=2");
    expect(safe.stripped).toEqual(["key", "token"]);
  });

  it("refuses to make a link out of anything that is not http", () => {
    expect(safeUrl("javascript:alert(1)").href).toBeNull();
    expect(safeUrl("javascript:alert(1)").text).toBe("javascript:alert(1)");
    expect(safeUrl("").href).toBeNull();
  });
});

describe("stamp", () => {
  it("reads an iso instant as a date and a time labelled utc", () => {
    expect(stamp("2026-09-15T19:04:53Z")).toBe("2026-09-15 19:04 UTC");
  });

  it("hands back anything it cannot read rather than inventing a date", () => {
    expect(stamp("sometime")).toBe("sometime");
    expect(stamp("")).toBe("");
  });
});

describe("shortHash", () => {
  const sha = "f7eca3f886f0bf58d59554df9dfea6e500642148ce473d1e0ac81fd92fc4cc86";

  it("keeps the first twelve characters of a sha256 and marks the rest as cut", () => {
    expect(shortHash(sha)).toBe("f7eca3f886f0...");
    expect(sha.startsWith(shortHash(sha).slice(0, -3))).toBe(true);
  });

  it("does not truncate a value that is already short", () => {
    expect(shortHash("abc")).toBe("abc");
  });
});

// the built json is optional in ci, so this suite skips when it is absent
const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const built: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

describe.skipIf(!present)("the provenance block of the built metros.json", () => {
  it("has one row per source folder, each naming a file and its checksum", () => {
    const report = buildSources(built!);
    // sixteen raw folders and the model's own export, which is computed here
    expect(report.rows).toHaveLength(17);
    for (const { entry: row } of report.rows) {
      expect(row.sha256, row.source).toMatch(/^[0-9a-f]{64}$/);
      expect(row.filename, row.source).not.toBe("");
      expect(row.row_count, row.source).toBeGreaterThan(0);
      expect(row.files, row.source).toBeGreaterThan(0);
      expect(row.downloaded_at, row.source).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("carries no credential in any upstream url, and every url is one a reader can open", () => {
    for (const { entry: row } of buildSources(built!).rows) {
      const safe = safeUrl(row.url);
      expect(safe.stripped, `${row.source} url`).toEqual([]);
      // the model's export was computed here rather than fetched, so its
      // address is the code that wrote it and there is nothing to open
      if (row.source === "forecast") expect(safe.href, `${row.source} url`).toBeNull();
      else expect(safe.href, `${row.source} url`).toBe(row.url);
    }
  });

  it("builds metrics out of thirteen folders and names what the other four do", () => {
    const report = buildSources(built!);
    const quiet = report.rows.filter((r) => r.metrics.length === 0).map((r) => r.entry.source);
    expect(quiet).toEqual(["boundaries", "fred", "gazetteer", "national"]);
    for (const row of report.rows) {
      if (row.metrics.length === 0) expect(row.role, row.entry.source).not.toBeNull();
      else expect(row.role, row.entry.source).toBeNull();
    }
  });

  it("gives every visible metric a folder, the model's included", () => {
    const report = buildSources(built!);
    expect(report.unsourced).toEqual([]);
    const placed = new Set(report.rows.flatMap((r) => r.metrics.map((d) => d.id)));
    for (const def of visibleDefs(built!.metros)) expect(placed.has(def.id), def.id).toBe(true);
  });

  it("names a metric under one folder only, so no number is claimed twice", () => {
    const ids = buildSources(built!).rows.flatMap((r) => r.metrics.map((d) => d.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries a vintage for every folder the sources block also names", () => {
    const report = buildSources(built!);
    for (const { entry: row } of report.rows) {
      expect(row.version, row.source).not.toBe("");
      expect(row.provider, row.source).not.toBe("");
    }
    // and this build read every folder it names, so no row wears the mark
    for (const row of report.rows) expect(row.read, row.entry.source).toBe(true);
    // the vintage line and the provenance table are two readings of one list
    // of folders. a source in one and not the other leaves a reader deciding
    // which of the two to believe
    const folders = new Set(report.rows.map((r) => r.entry.source));
    expect(Object.keys(built!.sources).filter((k) => !folders.has(k))).toEqual([]);
    expect([...folders].filter((f) => !(f in built!.sources))).toEqual([]);
  });

  it("agrees with the source labels the rest of the site uses", () => {
    for (const row of buildSources(built!).rows) {
      if (row.source === null) continue;
      expect(row.label).toBe(SOURCE_LABEL[row.source as Source]);
    }
  });
});

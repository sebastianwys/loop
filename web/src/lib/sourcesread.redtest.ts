// a red test for the audit's download-evidence finding. run it deliberately,
// the vitest include does not pick a *.redtest.ts up:
//   node -e "import('vitest/node').then(async(m)=>{const v=await m.startVitest('test',[],{watch:false,include:['src/lib/sourcesread.redtest.ts']});await v?.close();})"

import { describe, expect, it } from "vitest";
import { buildSources } from "./sources";
import type { MapData, Provenance } from "../types";

// the two blocks carry different evidence on purpose. sources is what this
// build read, and goes null where it read nothing; provenance is what landed on
// disk, and keeps the manifest row verbatim. the page shows both, so a folder
// this build never opened prints a vintage in one table and a blank in the
// other, and nothing on the page says which to believe
const entry = (source: string, version: string): Provenance => ({
  source,
  provider: "a publisher",
  url: `https://example.org/${source}.csv`,
  version,
  downloaded_at: "2026-09-16T00:00:00Z",
  files: 1,
  row_count: 10,
  filename: `${source}.csv`,
  sha256: "4f2a",
});

const data = (sources: Record<string, string | null>, rows: Provenance[]): MapData =>
  ({ generated_at: "2026-09-17T00:00:00Z", years: [2014, 2019, 2024], sources, provenance: rows, metros: [] }) as unknown as MapData;

describe("a provenance row says whether this build read the file", () => {
  // point fhfa at a missing path: exit 0, every price history gone, and
  // sources.fhfa null. the provenance row still reads 2026-Q2
  it("marks the row whose vintage line this build could not fill", () => {
    const report = buildSources(data({ fhfa: null, census: "ACS 5-year 2024" },
                                      [entry("fhfa", "2026-Q2"), entry("census", "ACS 5-year 2024")]));
    const fhfa = report.rows.find((r) => r.entry.source === "fhfa");
    expect(fhfa?.read, "the build read no fhfa frame and the page cannot tell").toBe(false);
    // and the landing record is untouched, which is what the table is for
    expect(fhfa?.entry.version).toBe("2026-Q2");
    expect(fhfa?.entry.sha256).toBe("4f2a");
  });

  it("leaves a folder this build did read unmarked", () => {
    const report = buildSources(data({ fhfa: "2026-Q2" }, [entry("fhfa", "2026-Q2")]));
    expect(report.rows[0].read).toBe(true);
  });

  // a build old enough to have no sources block at all cannot support either
  // claim, so it makes neither
  it("says nothing about a build with no vintage line", () => {
    const report = buildSources({ provenance: [entry("fhfa", "2026-Q2")] } as unknown as MapData);
    expect(report.rows[0].read).toBe(null);
  });
});

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INHERITED_DASH, INHERITED_FILL_OPACITY, shapeStyle } from "./boundaries";
import { rankingCsv } from "./csv";
import { buildExplore, fitSentence, plotSize } from "./explore";
import { defById, isInherited, resolveMetric } from "./metrics";
import { INK_2 } from "./palette";
import { rankMetros } from "./rank";
import { buildScale } from "./scale";
import type { MapData } from "../types";

// the built json is optional in ci, so this suite skips when it is absent
const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

const metricAt = (id: string, period: "latest") => resolveMetric(defById(id)!.def, period);

// zillow publishes metros only, so the 37 metropolitan divisions carry the
// parent metro's zhvi and zori. that is marked by zillow_scope rather than by
// parent_metrics, and a value taken whole from a parent is not this metro's
// own measurement: it is drawn hollow, kept out of every fit, and never ranked
describe.skipIf(!present)("a zillow series a metropolitan division took from its parent", () => {
  // counted as their own measurement, the divisions would put one parent's
  // number into the fitted line more than once, and the caption would report
  // the inflated r out loud
  it("is hollow in the explore scatter and left out of the fitted line", () => {
    const metros = data!.metros;
    const x = metricAt("zhvi", "latest");
    const y = metricAt("pop_estimate", "latest");
    const model = buildExplore(metros, x, y, plotSize("wide"));

    expect(model.counts.plotted).toBe(403);
    expect(model.counts.inherited).toBe(37);
    // newark's home value index is the new york metro's, shared with three
    // other divisions of the same msa
    expect(model.points.find((p) => p.cbsa === "35084")!.inherited).toBe(true);

    expect(model.fit!.n).toBe(366);
    expect(model.fit!.r).toBeCloseTo(0.2458, 4);
    const sentence = fitSentence(model, y.label);
    expect(sentence).toContain("A least squares line through the 366 metros that measure both:");
    expect(sentence).toContain("r is 0.25");
    expect(sentence).toContain("6 percent of the spread");
  });

  // ranked, one measurement would fill four rows of the same top ten under
  // four division names
  it("does not rank, so one measurement fills one row of the top ten", () => {
    const metros = data!.metros;
    const metric = metricAt("zori", "latest");
    const ranked = rankMetros(metros, metric);

    expect(ranked.slice(0, 5).map((r) => `${r.metro.name} ${Math.round(r.value)}`)).toEqual([
      "San Jose-Sunnyvale-Santa Clara, CA 3815",
      "Santa Cruz-Watsonville, CA 3506",
      "Kahului-Wailuku, HI 3239",
      "Santa Maria-Santa Barbara, CA 3200",
      "Urban Honolulu, HI 3020",
    ]);
    expect(ranked.filter((r) => r.metro.zillow_scope === "parent metro").map((r) => r.metro.name)).toEqual([]);
    expect(ranked).toHaveLength(369);
  });

  // the download is the ranking, so it would carry the same repeats into a
  // spreadsheet
  it("is absent from the downloaded ranking, which holds one row per measurement", () => {
    const metros = data!.metros;
    const metric = metricAt("zhvi", "latest");
    const divisions = new Set(metros.filter((m) => m.level === "division").map((m) => m.cbsa));
    const rows = rankingCsv(rankMetros(metros, metric), metric).trimEnd().split("\r\n").slice(1);

    expect(rows).toHaveLength(366);
    // rank and cbsa are the two unquoted leading fields of every row
    const codes = rows.map((line) => line.split(",")[1]);
    expect(codes.filter((c) => divisions.has(c))).toEqual([]);
    // name, label and the formatted value are quoted and carry commas of their
    // own, so the raw value column has to be read with the quoting respected
    const values = rows.map((line) => fields(line)[5]);
    expect(new Set(values).size).toBe(values.length);
  });
});

// one csv row into its fields, respecting the quoting toCsv writes
function fields(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  out.push(cell);
  return out;
}

// the restyle effect has to hand shapeStyle the inherited flag along with
// { selected }, or the mark the creation effect sets is dropped the moment
// the metric, scale or selection changes. anaheim inherits active_listings
// through parent_metrics
describe.skipIf(!present)("a division's shape in the shapes view", () => {
  it("keeps the inherited mark when the layer is restyled", () => {
    const metros = data!.metros;
    const metric = metricAt("active_listings", "latest");
    const anaheim = metros.find((m) => m.cbsa === "11244")!;
    const scale = buildScale(metros.map(metric.accessor), metric.kind);

    expect(isInherited(anaheim, metric)).toBe(true);
    expect(metric.accessor(anaheim)).toBe(20134);
    // what the shape has to wear: lighter, inked and dashed, so the reader can
    // tell the parent metro's listing count from a measurement of anaheim
    expect(shapeStyle(metric.accessor(anaheim), scale, { selected: false, inherited: true })).toMatchObject({
      fillOpacity: INHERITED_FILL_OPACITY,
      color: INK_2,
      dashArray: INHERITED_DASH,
    });

    // the restyle effect is the one that refreshes the tooltip. there is no dom
    // in this suite to mount leaflet into, so the flag is read off the call
    const source = readFileSync(new URL("../components/ShapeLayer.tsx", import.meta.url).pathname, "utf8");
    const restyle = source.slice(source.lastIndexOf("useEffect"));
    expect(restyle).toContain("setTooltipContent");
    expect(/shapeStyle\(([^;]*)\)/.exec(restyle)![1]).toContain("inherited");
  });
});

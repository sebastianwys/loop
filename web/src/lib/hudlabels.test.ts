// what the site says of hud's years
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defById, metricCaption, resolveMetric } from "./metrics";
import { buildTimeline, laterStartsNote, periodLabel } from "./timeline";
import type { MapData, Period } from "../types";

const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

const MANIFEST = new URL("../../../data/raw/hud/download_manifest.json", import.meta.url).pathname;

// hud publishes by fiscal year and the 2024 panel holds hud_2024.json, fiscal
// 2024. the year panels are labelled as fiscal years, the way latest reads
// FY 2027
describe.skipIf(!present)("a hud year panel", () => {
  const fmr = () => defById("fmr_2br")!.def;
  const abilene = () => data!.metros.find((m) => m.cbsa === "10180")!;

  it("is labelled the way latest is (premise)", () => {
    expect(periodLabel(resolveMetric(fmr(), "latest"), abilene())).toBe("FY 2027");
    expect(abilene().years["2024"].fmr_2br).toBe(1117);
  });

  it("captions the legend as a fiscal year", () => {
    expect(metricCaption(resolveMetric(fmr(), "2024"), data!.metros)).toBe("Source: HUD, FY 2024");
  });

  it("gives the map tooltip a fiscal year", () => {
    expect(periodLabel(resolveMetric(fmr(), "2024"), abilene())).toBe("FY 2024");
  });

  it("labels the timeline's year ticks as fiscal years", () => {
    const ticks = buildTimeline(fmr(), data!.metros).ticks.filter((t) => t.period !== "latest").map((t) => t.label);
    expect(ticks).toEqual(["FY 2014", "FY 2019", "FY 2024"]);
  });
});

// the build reads hud through its api, and the collector records a year the
// api answered with nothing. that is a fact about the api, not about what hud
// has published: hud's own fair market rent history covers fiscal 2014
describe.skipIf(!existsSync(MANIFEST))("why the hud cells are blank at 2014", () => {
  it("says the api this build reads has nothing, not that hud published nothing", () => {
    const [entry] = JSON.parse(readFileSync(MANIFEST, "utf8")) as { source: { endpoint: string }; notes: { years_without_data: number[] } }[];
    expect(entry.source.endpoint).toContain("hudapi");
    expect(entry.notes.years_without_data).toContain(2014);

    const note = laterStartsNote([
      { label: "Fair market rent, two bedroom", periods: ["2019", "2024", "latest"] as Period[], source: "hud" },
      { label: "Median family income", periods: ["2019", "2024", "latest"] as Period[], source: "hud" },
    ]);
    expect(note).not.toMatch(/HUD publishes no/);
    expect(note).toMatch(/\bAPI\b/);
  });
});

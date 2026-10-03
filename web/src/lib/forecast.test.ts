import { describe, expect, it } from "vitest";
import { againstRidge, bandLine, forecastCaption, forecastExplainer, forecastLines, indexErrorLine } from "./forecast";
import { SAMPLE } from "./data";
import { SHIPPED, horizonsIn, matchedBy, matchedPhrase, points, rowAt } from "./model";
import { BACKTEST, PAIRED } from "./modelNumbers";
import type { Metro } from "../types";

const abilene = SAMPLE.metros[0];
const dallas = SAMPLE.metros[1];
const sparse = SAMPLE.metros[2];

describe("bandLine", () => {
  it("renders the point with its band, signed, in percent", () => {
    expect(bandLine(abilene, "hpi_forecast_4q")).toBe("+3.1% (band -1.2% to +7.0%)");
    expect(bandLine(abilene, "hpi_forecast_8q")).toBe("+6.0% (band -2.5% to +14.2%)");
    expect(bandLine(dallas, "hpi_forecast_4q")).toBe("-0.8% (band -5.0% to +3.6%)");
  });

  it("leaves the band off without both edges and the line off without a point", () => {
    const noHi = { ...abilene, latest: { ...abilene.latest, hpi_forecast_4q_hi: null } } as Metro;
    expect(bandLine(noHi, "hpi_forecast_4q")).toBe("+3.1%");
    expect(bandLine(sparse, "hpi_forecast_4q")).toBeNull();
    expect(bandLine({} as Metro, "hpi_forecast_8q")).toBeNull();
  });
});

describe("forecastLines", () => {
  it("lists the five lines in reading order with the menu labels", () => {
    expect(forecastLines(abilene)).toEqual([
      { id: "hpi_forecast_4q", label: "Expected HPI growth, next 4 quarters", text: "+3.1% (band -1.2% to +7.0%)" },
      { id: "hpi_forecast_8q", label: "Expected HPI growth, next 8 quarters", text: "+6.0% (band -2.5% to +14.2%)" },
      { id: "hpi_trend_5y", label: "HPI growth, 5 year annualized", text: "+5.4%", source: "FHFA" },
      { id: "hpi_yoy_latest", label: "HPI growth, last 4 quarters", text: "+2.0%", source: "FHFA" },
      { id: "hpi_surprise_4q", label: "Surprise, actual minus expected, last 4 quarters", text: "-1.1 pp" },
    ]);
  });

  // realized growth rides in the model's export but is what the fhfa index
  // did, so its rows name fhfa. the model's own lines, the surprise among
  // them, sit under the caption's source
  it("names fhfa on the realized growth rows and nothing on the model's own", () => {
    const credited = forecastLines(abilene).filter((l) => l.source !== undefined);
    expect(credited.map((l) => [l.id, l.source])).toEqual([["hpi_trend_5y", "FHFA"], ["hpi_yoy_latest", "FHFA"]]);
  });

  // the export dates the surprise at the quarter the scored call was made,
  // four before the origin the caption names, so that row carries its own
  it("dates a line apart from the caption's origin with its own month", () => {
    const later = { ...abilene, latest: { ...abilene.latest, hpi_surprise_4q_date: "2025-06" } } as Metro;
    const lines = forecastLines(later);
    expect(forecastCaption(later)).toBe("Source: Loop model, origin 2026-06");
    expect(lines.find((l) => l.id === "hpi_surprise_4q")?.date).toBe("2025-06");
    expect(lines.filter((l) => l.date !== undefined).map((l) => l.id)).toEqual(["hpi_surprise_4q"]);
  });

  it("skips missing lines and is empty without a forecast", () => {
    const partial = { ...abilene, latest: { ...abilene.latest, hpi_surprise_4q: null, hpi_forecast_8q: null } } as Metro;
    expect(forecastLines(partial).map((l) => l.id)).toEqual(["hpi_forecast_4q", "hpi_trend_5y", "hpi_yoy_latest"]);
    expect(forecastLines(sparse)).toEqual([]);
    expect(forecastLines({} as Metro)).toEqual([]);
  });
});

describe("forecastCaption", () => {
  it("names the model and the origin month, the model alone without a date", () => {
    expect(forecastCaption(abilene)).toBe("Source: Loop model, origin 2026-06");
    expect(forecastCaption(sparse)).toBe("Source: Loop model");
    expect(forecastCaption({} as Metro)).toBe("Source: Loop model");
  });
});

// the index standard error is fhfa's, so it sits beside the forecasts credited
// to fhfa, in the units metrics.ts gives it
describe("indexErrorLine", () => {
  it("reads the error off the metro and credits fhfa", () => {
    const metro = { ...abilene, latest: { ...abilene.latest, hpi_index_error: 1.84 } } as Metro;
    expect(indexErrorLine(metro)).toEqual({ label: "Index standard error", text: "1.84%", source: "FHFA" });
  });

  it("is null for a metro without one", () => {
    expect(indexErrorLine({ ...abilene, latest: { ...abilene.latest, hpi_index_error: null } } as Metro)).toBeNull();
    expect(indexErrorLine({} as Metro)).toBeNull();
  });
});

// the coverage the explainer quotes is the backtest band's, calibrated on 2018
// to 2021. the band drawn beside it is the shipped one, set separately
describe("the forecast explainer's coverage", () => {
  const { sentences } = forecastExplainer(abilene);
  const near = rowAt(BACKTEST, SHIPPED, 4)!;
  const far = rowAt(BACKTEST, SHIPPED, 8)!;

  it("names the backtest as the band whose coverage it quotes", () => {
    const quoting = sentences.filter((s) => s.includes(points(near.coverage)) || s.includes(points(far.coverage)));
    expect(quoting.length).toBeGreaterThan(0);
    for (const sentence of quoting) expect(sentence).toMatch(/backtest/);
  });

  it("says the band drawn here is the shipped one, with its own margin", () => {
    expect(sentences[1]).toContain("The band drawn here");
    expect(sentences[1]).toContain("separate band model");
  });

  it("says short of nine in ten only where the backtest fell short", () => {
    const short = near.coverage < 0.9 || far.coverage < 0.9;
    expect(sentences[2].includes("short")).toBe(short);
  });

  // ridge's lead on the table is within what the paired test puts down to
  // chance, so the panel calls the two tied rather than giving ridge the edge,
  // and says so only while the p values do
  it("calls ridge and the gru tied only while the paired test puts every gap between them down to chance", () => {
    const ridge = PAIRED.filter((r) => r.against === "ridge" && Number.isFinite(r.pValue));
    const tie = ridge.length === horizonsIn(BACKTEST).length && ridge.every((r) => r.pValue >= 0.05);
    const leads = matchedPhrase(matchedBy(BACKTEST, "ridge", SHIPPED)) !== null;
    expect(sentences.join(" ")).not.toContain("same inputs");
    expect(sentences[3]).not.toContain("more years of data");
    expect(sentences[3].includes("A paired test puts every gap between them down to chance, so the two are tied")).toBe(leads && tie);
    const apart = PAIRED.map((r) => (r.against === "ridge" && r.horizon === 2 ? { ...r, pValue: 0.01 } : r));
    expect(againstRidge(BACKTEST, apart)).not.toContain("tied");
    if (leads) expect(againstRidge(BACKTEST, apart)).toContain("a lead a paired test separates from chance at two quarters");
  });
});

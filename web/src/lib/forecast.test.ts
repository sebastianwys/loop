import { describe, expect, it } from "vitest";
import { bandLine, forecastCaption, forecastLines } from "./forecast";
import { SAMPLE } from "./data";
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
      { id: "hpi_trend_5y", label: "HPI growth, 5 year annualized", text: "+5.4%" },
      { id: "hpi_yoy_latest", label: "HPI growth, last 4 quarters", text: "+2.0%" },
      { id: "hpi_surprise_4q", label: "Surprise, actual minus expected, last 4 quarters", text: "-1.1 pp" },
    ]);
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

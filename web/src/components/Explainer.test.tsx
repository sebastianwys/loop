import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "../lib/data";
import { forecastExplainer } from "../lib/forecast";
import { metricById, metricExplainer } from "../lib/metrics";
import { BACKTEST } from "../lib/modelNumbers";
import { SHIPPED, points, rowAt } from "../lib/model";
import { DetailPanel } from "./DetailPanel";
import { Explainer } from "./Explainer";

const html = (node: ReactElement) => renderToStaticMarkup(node);
const metro = (cbsa: string) => SAMPLE.metros.find((m) => m.cbsa === cbsa)!;
const panel = (cbsa: string) => html(<DetailPanel metro={metro(cbsa)} metros={SAMPLE.metros} onClose={() => {}} />);

describe("the question mark beside a heading", () => {
  it("offers a button that names what it explains, so the label is not just a glyph", () => {
    const markup = html(<Explainer label="these forecasts">a sentence</Explainer>);
    expect(markup).toContain('aria-label="what these forecasts means"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(">?<");
  });

  it("keeps the sentences closed until asked, which is the point of moving them here", () => {
    const markup = html(<Explainer label="these forecasts">a sentence</Explainer>);
    expect(markup).not.toContain("a sentence");
  });
});

describe("what the detail panel says without being asked", () => {
  const markup = panel("10180");

  it("has stopped printing the forecast source as standing prose", () => {
    expect(markup).not.toContain("Source: Loop model");
    expect(markup).toContain('aria-label="what these forecasts means"');
  });

  it("has stopped printing the chart caption as standing prose", () => {
    expect(markup).not.toContain("Annual mean of the index");
    expect(markup).toContain('aria-label="what this chart means"');
  });
});

describe("the forecast definition", () => {
  const { sentences, source } = forecastExplainer(metro("10180"));

  it("is three sentences, which is what a reader will actually read", () => {
    expect(sentences).toHaveLength(3);
    for (const sentence of sentences) expect(sentence.endsWith(".")).toBe(true);
  });

  it("says what the model is and what the band is before it says what it misses", () => {
    expect(sentences[0]).toContain("sequence GRU");
    expect(sentences[1]).toContain("conformal");
  });

  // the page's rule is that every number is read from the shipped backtest,
  // so a retrain moves the copy with it. a hand typed coverage would drift
  it("reads its coverage out of the backtest rather than carrying a copy", () => {
    const near = rowAt(BACKTEST, SHIPPED, 4);
    const far = rowAt(BACKTEST, SHIPPED, 8);
    expect(sentences[2]).toContain(points(near!.coverage));
    expect(sentences[2]).toContain(points(far!.coverage));
  });

  it("keeps the attribution, moved inside the bubble rather than dropped", () => {
    expect(source).toContain("Loop model");
  });
});

describe("what the colour on the map means", () => {
  it("says a vintage change is a change, which the timeline used to say", () => {
    const text = metricExplainer(metricById("hpi_19_24"));
    expect(text).toContain("change measured between the two shaded vintage years");
    expect(text).not.toContain("at the period the timeline is set to");
  });

  it("says a dated metric is read at the timeline's period", () => {
    const text = metricExplainer(metricById("unemp"));
    expect(text).toContain("at the period the timeline is set to");
  });

  // the bare source line under the select is gone, so the bubble has to carry
  // the attribution or the map stops saying where its numbers came from
  it("keeps the source it replaced", () => {
    expect(metricExplainer(metricById("hpi_19_24"))).toContain("FHFA");
    expect(metricExplainer(metricById("unemp"))).toContain("BLS LAUS");
  });
});

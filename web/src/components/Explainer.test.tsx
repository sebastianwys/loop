import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "../lib/data";
import { forecastExplainer } from "../lib/forecast";
import { defById, metricById, metricExplainer } from "../lib/metrics";
import { BACKTEST } from "../lib/modelNumbers";
import { SHIPPED, points, rowAt } from "../lib/model";
import { buildDeepTimeline, yearMetric } from "../lib/timeline";
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

  // the fourth says how ridge did against the gru and why the gru ships
  // anyway, which a reader of the map is owed as much as the band
  it("is four sentences, which is still what a reader will actually read", () => {
    expect(sentences).toHaveLength(4);
    for (const sentence of sentences) expect(sentence.endsWith(".")).toBe(true);
  });

  // read off the backtest here rather than through the page's own reader, so
  // a retrain that puts the gru ahead of ridge cannot leave the claim behind
  it("says ridge matches or beats the gru everywhere only while the backtest does, and why the gru ships", () => {
    const horizons = [...new Set(BACKTEST.map((r) => r.horizon))];
    const everywhere = horizons.every((h) => {
      const ridge = rowAt(BACKTEST, "ridge", h);
      const gru = rowAt(BACKTEST, SHIPPED, h);
      return ridge !== null && gru !== null && ridge.maePct <= gru.maePct && ridge.width <= gru.width;
    });
    expect(sentences[3].includes("matches or beats the GRU at every horizon, on error and on band width")).toBe(everywhere);
    expect(sentences[3]).toContain("the pipeline picks between the two networks, not against ridge");
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

  // with the index chosen the map runs its annual history and is coloured by
  // growth into the scrubbed year, which is what the sidebar is handed
  it("says the year timeline colours by growth, not by the level", () => {
    const hpi = defById("hpi")!.def;
    const shown = yearMetric(hpi, buildDeepTimeline(hpi, SAMPLE.metros)!, 2021);
    const text = metricExplainer(shown);
    expect(text).toContain("coloured by its House price index growth, 2020 to 2021");
    expect(text).not.toContain("at the period the timeline is set to");
    expect(text).toContain("FHFA");
  });

  // the bare source line under the select is gone, so the bubble has to carry
  // the attribution or the map stops saying where its numbers came from
  it("keeps the source it replaced", () => {
    expect(metricExplainer(metricById("hpi_19_24"))).toContain("FHFA");
    expect(metricExplainer(metricById("unemp"))).toContain("BLS LAUS");
  });
});

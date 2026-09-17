import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "../lib/data";
import { DEFS, metricById, visibleDefs } from "../lib/metrics";
import { buildScale } from "../lib/scale";
import { Sidebar } from "./Sidebar";

// the export control only. no dom in this suite, so the markup is read as a
// string: it proves the button a reader is offered, not the download itself

const metric = metricById("hpi_19_24");

const render = (condensed = false) =>
  renderToStaticMarkup(
    <Sidebar
      metros={SAMPLE.metros}
      defs={visibleDefs(SAMPLE.metros)}
      metric={metric}
      period={metric.period}
      available={DEFS[0].periods}
      scale={buildScale(SAMPLE.metros.map(metric.accessor), metric.kind)}
      selectedCbsa={null}
      sources={SAMPLE.sources}
      generatedAt={SAMPLE.generated_at}
      onMetricChange={() => {}}
      onPeriodChange={() => {}}
      onSelect={() => {}}
      mode="dots"
      shapesStatus="idle"
      onModeChange={() => {}}
      condensed={condensed}
    />,
  );

describe("the sidebar export control", () => {
  it("is a real button, not a link dressed as one", () => {
    expect(render()).toContain('<button type="button" class="linkish" aria-label=');
    expect(render()).toContain(">download csv</button>");
  });

  it("says what the file will hold, including how many metros are in it", () => {
    // two of the three sample metros carry this metric, and the third is a
    // division that took its value from the parent
    expect(render()).toContain('aria-label="download all 2 metros ranked by hpi growth, 2019 to 2024 as a csv file"');
  });

  it("keeps its label on a sidebar dragged narrow, where the headings shorten", () => {
    expect(render(true)).toContain(">download csv</button>");
  });

  it("still shows the top fifteen beside it, so the export is not the only way out", () => {
    expect(render()).toContain(">show all as a table</button>");
  });

  it("is not offered at all when the metric ranks nobody, rather than offered and dead", () => {
    const empty = renderToStaticMarkup(
      <Sidebar
        metros={[]}
        defs={DEFS}
        metric={metric}
        period={metric.period}
        available={DEFS[0].periods}
        scale={buildScale([], metric.kind)}
        selectedCbsa={null}
        sources={SAMPLE.sources}
        generatedAt={SAMPLE.generated_at}
        onMetricChange={() => {}}
        onPeriodChange={() => {}}
        onSelect={() => {}}
        mode="dots"
        shapesStatus="idle"
        onModeChange={() => {}}
      />,
    );
    expect(empty).not.toContain("download csv");
  });
});

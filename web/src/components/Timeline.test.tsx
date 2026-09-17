import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAMPLE } from "../lib/data";
import { defById } from "../lib/metrics";
import { buildDeepTimeline } from "../lib/timeline";
import type { Metro, Period } from "../types";
import { Timeline, YearScrubContext, type YearScrub } from "./Timeline";

// no dom in this suite, so the markup is read as a string: it proves the aria
// wiring a screen reader and a keyboard need, not the playback
const def = (id: string) => defById(id)!.def;
const hpi = def("hpi");
const deep = buildDeepTimeline(hpi, SAMPLE.metros)!;

const one = (start: number, values: (number | null)[], partial?: number): Metro =>
  ({ ...SAMPLE.metros[0], series: { hpi: { start, values, as_of: "2026Q2", partial_year: partial } } }) as Metro;

function render(scrub: YearScrub | null, id = "hpi", period: Period | null = "latest"): string {
  const d = def(id);
  return renderToStaticMarkup(
    <YearScrubContext.Provider value={scrub}>
      <Timeline
        def={d}
        metros={SAMPLE.metros}
        period={period}
        available={d.periods}
        onPeriodChange={() => {}}
      />
    </YearScrubContext.Provider>,
  );
}

const scrub = (over: Partial<YearScrub> = {}): YearScrub =>
  ({ deep, year: 2021, onYearChange: () => {}, reducedMotion: false, ...over });

describe("the timeline with no history behind the metric", () => {
  it("draws the four vintage panels when nothing provides a run", () => {
    const markup = render(null, "income", "2024");
    expect(markup).toContain('data-period="2014"');
    expect(markup).toContain('data-period="latest"');
    expect(markup).toContain('aria-label="play through the periods"');
    expect(markup).not.toContain('type="range"');
  });

  it("draws the four vintage panels when the run is absent for this metric", () => {
    const markup = render(scrub({ deep: null }), "unemp");
    expect(markup).toContain('data-period="2019"');
    expect(markup).not.toContain('type="range"');
  });

  it("leaves a change figure showing its shaded span and no ticks", () => {
    const markup = render(scrub({ deep: null }), "hpi_19_24", null);
    expect(markup).toContain("a change between the shaded years");
    expect(markup).not.toContain('type="range"');
  });
});

describe("the timeline over a deep annual history", () => {
  it("replaces the panels with a scrubber over the years", () => {
    const markup = render(scrub());
    expect(markup).not.toContain('data-period="2014"');
    expect(markup).toContain('type="range"');
    expect(markup).toContain('min="0"');
    expect(markup).toContain(`max="${deep.frames.length - 1}"`);
    expect(markup).toContain('step="1"');
  });

  it("puts the scrubber on the frame the year names and says which year that is", () => {
    const markup = render(scrub({ year: 2021 }));
    // 2015 is the first frame, so 2021 is the seventh
    expect(markup).toContain('value="6"');
    expect(markup).toContain('aria-valuetext="2021, 1 of 3 metros"');
    expect(markup).toContain(">2021</span>");
  });

  it("names what the scrubber is, so the value is not read on its own", () => {
    const markup = render(scrub());
    expect(markup).toContain('aria-labelledby="period-label"');
    expect(markup).toContain('id="period-label">year</span>');
  });

  // the scrubber's own value is the announcement while it has focus. the live
  // region is for the one change nobody would hear, the end of a run
  it("leaves the announcement to the scrubber rather than reading the year twice", () => {
    const markup = render(scrub());
    expect(markup).toContain('<p class="year-read" aria-hidden="true">');
    expect(markup).toContain('<span class="sr" role="status"></span>');
  });

  it("gives the play button a label that names the years it would run", () => {
    const markup = render(scrub());
    expect(markup).toContain('aria-label="play the years, 2015 to 2026"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain("disabled");
  });

  it("says a run will step rather than animate for a reader who asked for less motion", () => {
    expect(render(scrub({ reducedMotion: true }))).toContain("your system asks for less motion");
    expect(render(scrub())).not.toContain("your system asks for less motion");
  });

  it("states that a metro with no index that year is no data and not a zero", () => {
    const markup = render(scrub());
    expect(markup).toContain("drawn as no data, not as zero");
    expect(markup).toContain("one colour scale for every year");
    expect(markup).toContain("clipped at plus or minus 5 percent");
  });

  it("draws a bar per year, so the thin early years are visible before they are read", () => {
    const markup = render(scrub());
    expect(markup.match(/class="bar/g)).toHaveLength(deep.frames.length);
    expect(markup).toContain('class="bar at"');
  });

  it("marks a partial final year as unfinished everywhere it is named", () => {
    const partial = buildDeepTimeline(hpi, [one(1990, [100, 105, 110], 1992)])!;
    const markup = render(scrub({ deep: partial, year: 1992 }));
    expect(markup).toContain(">1992 so far</span>");
    expect(markup).toContain('aria-valuetext="1992 so far, 1 of 1 metros"');
    expect(markup).toContain('aria-label="play the years, 1991 to 1992 so far"');
  });

  it("disables play when the history is one frame wide, since there is nothing to run", () => {
    const lone = buildDeepTimeline(hpi, [one(1990, [100, 110])])!;
    const markup = render(scrub({ deep: lone, year: 1991 }));
    expect(markup).toContain("disabled");
    expect(markup).toContain('max="0"');
    expect(markup).toContain('value="0"');
  });

  it("falls back to the newest year when no year has been picked yet", () => {
    const markup = render(scrub({ year: null }));
    expect(markup).toContain(`value="${deep.frames.length - 1}"`);
    expect(markup).toContain(">2026</span>");
  });
});

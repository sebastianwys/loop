import { useCallback, useEffect, useMemo, useState } from "react";
import { loadBoundaries, type BoundaryIndex } from "../lib/boundaries";
import { closesOnSelect, legendStartsOpen } from "../lib/layout";
import { isInherited, metricCaption, visibleDefs } from "../lib/metrics";
import { routeMetric } from "../lib/route";
import { buildScale } from "../lib/scale";
import { buildDeepTimeline, deepCaption, frameAt, yearMetric } from "../lib/timeline";
import type { ViewProps } from "../lib/views";
import { DetailPanel } from "./DetailPanel";
import { Legend } from "./Legend";
import { MapView } from "./MapView";
import { Sidebar } from "./Sidebar";
import { SidebarGrip } from "./SidebarGrip";
import { YearScrubContext, type YearScrub } from "./Timeline";

export type ShapesStatus = "idle" | "loading" | "ready" | "failed";

// the default view: the metros drawn on a map, with the controls beside it.
// the shell owns the sidebar because the layout classes are the shell's; the
// boundary file and the legend belong to nobody else and live here
export function MapPage({ data, route, go, viewport, shell }: ViewProps) {
  const metros = data.metros;
  const [boundaries, setBoundaries] = useState<BoundaryIndex | null>(null);
  const [shapesStatus, setShapesStatus] = useState<ShapesStatus>("idle");
  const [legendOpen, setLegendOpen] = useState(() => legendStartsOpen(viewport.mode));

  const mode = route.mode;
  const { open, drawer, setOpen } = shell;

  // the boundary file is fetched once, the first time shapes are chosen
  useEffect(() => {
    if (mode !== "shapes" || boundaries || shapesStatus !== "idle") return;
    setShapesStatus("loading");
    loadBoundaries().then((index) => {
      if (index) {
        setBoundaries(index);
        setShapesStatus("ready");
      } else {
        setShapesStatus("failed");
      }
    });
  }, [mode, boundaries, shapesStatus]);

  // a failed load latches, so without this the shapes view is dead until the
  // page is reloaded. leaving shapes clears it and coming back tries again
  useEffect(() => {
    if (mode !== "shapes" && shapesStatus === "failed") setShapesStatus("idle");
  }, [mode, shapesStatus]);

  // escape closes the drawer first, since that is what covers the map
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (drawer && open) setOpen(false);
      else go({ metro: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, open, setOpen, go]);

  // picking a metro from a drawer gets the drawer out of the way
  const onSelect = useCallback(
    (cbsa: string) => {
      go({ metro: cbsa });
      if (closesOnSelect(viewport.mode)) setOpen(false);
    },
    [go, setOpen, viewport.mode],
  );

  // the metric turns on two fields of the route and nothing else. reading the
  // whole route here would rebuild the colour scale, the caption and every
  // marker on the map each time a metro was picked or the sidebar was dragged
  const { metric, period, available } = useMemo(
    () => routeMetric(route, metros),
    [route.metric, route.period, metros],
  );
  const defs = useMemo(() => visibleDefs(metros), [metros]);
  // the annual history behind this metric, null for the fifty three metrics
  // whose sources publish nothing but the four vintage panels
  const deep = useMemo(() => buildDeepTimeline(metric.def, metros), [metric.def, metros]);
  // a year the reader left behind on another metric is clamped into this run
  const shownYear = deep ? frameAt(deep, route.year).year : null;
  // what the map, the legend and the ranking are all reading. one object, so
  // the three cannot disagree about which year is on screen
  const shown = useMemo(
    () => (deep ? yearMetric(metric.def, deep, shownYear) : metric),
    [deep, metric, shownYear],
  );
  // the colour scale is built once for the whole run, not once a frame: a
  // scale rebuilt per year would recolour the map under the reader and make
  // 1990 and 2010 incomparable, and it would churn a prop 410 markers read
  const scale = useMemo(
    () => (deep ? buildScale([-deep.cap, deep.cap], "diverging") : buildScale(metros.map(metric.accessor), metric.kind)),
    [deep, metros, metric],
  );
  const caption = useMemo(
    () => (deep ? deepCaption(metric.def, deep, shownYear) : metricCaption(metric, metros)),
    [deep, shownYear, metric, metros],
  );
  // the legend only explains the parent mark when something on the map wears it
  const anyInherited = useMemo(
    () => metros.some((m) => isInherited(m, shown) && shown.accessor(m) !== null),
    [metros, shown],
  );
  // the year is route state like the metric, so a link carries the frame the
  // reader was looking at. it is the fastest changing key the address bar has,
  // a new one every quarter second while the run plays, which is why route.ts
  // caps how often a replace reaches history
  const onYearChange = useCallback((year: number) => go({ year }), [go]);
  const scrub = useMemo<YearScrub>(
    () => ({ deep, year: shownYear, onYearChange, reducedMotion: viewport.reducedMotion }),
    [deep, shownYear, onYearChange, viewport.reducedMotion],
  );
  const selectedMetro = metros.find((m) => m.cbsa === route.metro) ?? null;

  return (
    <div
      className="main"
      style={shell.width === null ? undefined : ({ "--sidebar-w": `${shell.width}px` } as React.CSSProperties)}
    >
      <YearScrubContext.Provider value={scrub}>
        <Sidebar
          metros={metros}
          defs={defs}
          metric={shown}
          period={period}
          available={available}
          scale={scale}
          selectedCbsa={route.metro}
          sources={data.sources}
          generatedAt={data.generated_at}
          onMetricChange={(id) => go({ metric: id })}
          onPeriodChange={(next) => go({ period: next })}
          onSelect={onSelect}
          mode={mode}
          shapesStatus={shapesStatus}
          onModeChange={(next) => go({ mode: next })}
          drawer={drawer}
          condensed={shell.condensed}
          onClose={() => setOpen(false)}
        />
      </YearScrubContext.Provider>
      {!drawer && open && (
        <SidebarGrip
          width={shell.width}
          viewportWidth={viewport.width}
          measure={shell.measure}
          onResize={shell.resize}
          onCommit={shell.commit}
          onReset={shell.reset}
        />
      )}
      {drawer && open && (
        <button
          type="button"
          className="backdrop"
          aria-label="close the controls"
          tabIndex={-1}
          onClick={() => setOpen(false)}
        />
      )}
      <div className="map">
        <MapView
          metros={metros}
          metric={shown}
          scale={scale}
          selectedCbsa={route.metro}
          onSelect={onSelect}
          mode={mode}
          boundaries={boundaries}
          reducedMotion={viewport.reducedMotion}
        />
        <Legend
          scale={scale}
          metric={shown}
          caption={caption}
          open={legendOpen}
          onToggle={() => setLegendOpen((was) => !was)}
          inherited={anyInherited}
          clipped={deep !== null}
        />
        {selectedMetro && <DetailPanel metro={selectedMetro} metros={metros} onClose={() => go({ metro: null })} />}
      </div>
    </div>
  );
}

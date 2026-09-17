import { useCallback, useEffect, useMemo, useState } from "react";
import { DetailPanel } from "./components/DetailPanel";
import { Header } from "./components/Header";
import { Legend } from "./components/Legend";
import { MapView } from "./components/MapView";
import { Sidebar } from "./components/Sidebar";
import { SidebarGrip } from "./components/SidebarGrip";
import { loadBoundaries, type BoundaryIndex, type MapMode } from "./lib/boundaries";
import { loadMapData } from "./lib/data";
import { nationalIndicators } from "./lib/indicators";
import {
  SIDEBAR, clampSidebarWidth, closesOnSelect, legendStartsOpen, readSidebarWidth, sidebarIsCondensed,
  sidebarIsDrawer, sidebarStartsOpen, useViewport, writeSidebarWidth,
} from "./lib/layout";
import { DEFS, availablePeriods, defById, isInherited, metricCaption, nearestPeriod, resolveMetric, visibleDefs } from "./lib/metrics";
import { buildScale } from "./lib/scale";
import type { MapData, Period } from "./types";

interface Loaded {
  data: MapData;
  sample: boolean;
}

export type ShapesStatus = "idle" | "loading" | "ready" | "failed";

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [defId, setDefId] = useState(DEFS[0].id);
  const [period, setPeriod] = useState<Period | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<MapMode>("dots");
  const [boundaries, setBoundaries] = useState<BoundaryIndex | null>(null);
  const [shapesStatus, setShapesStatus] = useState<ShapesStatus>("idle");

  const viewport = useViewport();
  const drawer = sidebarIsDrawer(viewport.mode);
  const [sidebarOpen, setSidebarOpen] = useState(() => sidebarStartsOpen(viewport.mode));
  const [legendOpen, setLegendOpen] = useState(() => legendStartsOpen(viewport.mode));
  // null until the grip is dragged, and then the stylesheet's fluid width
  // gives way to the one the reader chose. a stored width is re-clamped every
  // render, so shrinking the window cannot leave the sidebar owning the map
  const [storedWidth, setStoredWidth] = useState<number | null>(readSidebarWidth);
  const sidebarWidth = storedWidth === null ? null : clampSidebarWidth(storedWidth, viewport.width);
  const condensed = !drawer && sidebarIsCondensed(sidebarWidth);

  // during a drag only the state moves. localStorage.setItem is synchronous
  // and would run on every pointermove, alongside leaflet resizing the map
  const resizeSidebar = useCallback((next: number) => setStoredWidth(next), []);

  const commitSidebarWidth = useCallback((next: number) => {
    setStoredWidth(next);
    writeSidebarWidth(next);
  }, []);

  const resetSidebar = useCallback(() => {
    setStoredWidth(null);
    writeSidebarWidth(null);
  }, []);

  // the grip needs a number even before the first drag, when the width is
  // still whatever the stylesheet worked out
  const measureSidebar = useCallback(
    () => document.getElementById("controls")?.getBoundingClientRect().width || SIDEBAR.condense,
    [],
  );

  // crossing the 900px line puts the sidebar back to what that layout wants.
  // resizing inside one layout leaves a collapse the reader asked for alone
  useEffect(() => {
    setSidebarOpen(sidebarStartsOpen(drawer ? "phone" : "wide"));
  }, [drawer]);

  useEffect(() => {
    loadMapData().then(setLoaded);
  }, []);

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
      if (drawer && sidebarOpen) setSidebarOpen(false);
      else setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, sidebarOpen]);

  // picking a metro from a drawer gets the drawer out of the way
  const onSelect = useCallback(
    (cbsa: string) => {
      setSelected(cbsa);
      if (closesOnSelect(viewport.mode)) setSidebarOpen(false);
    },
    [viewport.mode],
  );

  const metros = loaded?.data.metros ?? [];
  const indicators = useMemo(() => nationalIndicators(loaded?.data), [loaded]);
  const def = (defById(defId) ?? { def: DEFS[0] }).def;
  const defs = useMemo(() => visibleDefs(metros), [metros]);
  const available = useMemo(() => availablePeriods(def, metros), [def, metros]);
  // a metric that lacks the chosen period moves to the closest one it has
  const activePeriod = nearestPeriod(period, available);
  const metric = useMemo(() => resolveMetric(def, activePeriod), [def, activePeriod]);
  const scale = useMemo(() => buildScale(metros.map(metric.accessor), metric.kind), [metros, metric]);
  const caption = useMemo(() => metricCaption(metric, metros), [metric, metros]);
  // the legend only explains the parent mark when something on the map wears it
  const anyInherited = useMemo(
    () => metros.some((m) => isInherited(m, metric) && metric.accessor(m) !== null),
    [metros, metric],
  );
  const selectedMetro = metros.find((m) => m.cbsa === selected) ?? null;

  const shell = [
    "app",
    drawer ? "layout-drawer" : "layout-docked",
    sidebarOpen ? "sidebar-open" : "sidebar-closed",
    condensed ? "sidebar-condensed" : "",
    `mode-${viewport.mode}`,
  ].filter(Boolean).join(" ");

  if (!loaded) {
    return (
      <div className={shell}>
        <Header rate={null} sample={false} />
        <p style={{ padding: 16 }}>loading</p>
      </div>
    );
  }

  return (
    <div className={shell}>
      <Header
        rate={loaded.data.national?.mortgage_rate ?? null}
        sample={loaded.sample}
        count={loaded.data.metros.length}
        indicators={indicators}
        updated={loaded.data.national?.indicators_updated ?? null}
        sidebarOpen={sidebarOpen}
        drawer={drawer}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
      />
      <div
        className="main"
        style={sidebarWidth === null ? undefined : ({ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties)}
      >
        <Sidebar
          metros={metros}
          defs={defs}
          metric={metric}
          period={activePeriod}
          available={available}
          scale={scale}
          selectedCbsa={selected}
          sources={loaded.data.sources}
          generatedAt={loaded.data.generated_at}
          onMetricChange={setDefId}
          onPeriodChange={setPeriod}
          onSelect={onSelect}
          mode={mode}
          shapesStatus={shapesStatus}
          onModeChange={setMode}
          drawer={drawer}
          condensed={condensed}
          onClose={() => setSidebarOpen(false)}
        />
        {!drawer && sidebarOpen && (
          <SidebarGrip
            width={sidebarWidth}
            viewportWidth={viewport.width}
            measure={measureSidebar}
            onResize={resizeSidebar}
            onCommit={commitSidebarWidth}
            onReset={resetSidebar}
          />
        )}
        {drawer && sidebarOpen && (
          <button
            type="button"
            className="backdrop"
            aria-label="close the controls"
            tabIndex={-1}
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <div className="map">
          <MapView
            metros={metros}
            metric={metric}
            scale={scale}
            selectedCbsa={selected}
            onSelect={onSelect}
            mode={mode}
            boundaries={boundaries}
            reducedMotion={viewport.reducedMotion}
          />
          <Legend
            scale={scale}
            metric={metric}
            caption={caption}
            open={legendOpen}
            onToggle={() => setLegendOpen((open) => !open)}
            inherited={anyInherited}
          />
          {selectedMetro && <DetailPanel metro={selectedMetro} metros={metros} onClose={() => setSelected(null)} />}
        </div>
      </div>
    </div>
  );
}

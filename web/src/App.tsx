import { useCallback, useEffect, useMemo, useState } from "react";
import { Header } from "./components/Header";
import { ViewNav } from "./components/ViewNav";
import { loadMapData } from "./lib/data";
import { nationalIndicators } from "./lib/indicators";
import {
  SIDEBAR, clampSidebarWidth, readSidebarWidth, sidebarIsCondensed, sidebarIsDrawer, sidebarStartsOpen,
  useViewport, writeSidebarWidth,
} from "./lib/layout";
import { pruneMetros, useRoute, writeParams } from "./lib/route";
import { VIEWS, viewById, type Shell } from "./lib/views";
import type { MapData } from "./types";

interface Loaded {
  data: MapData;
  sample: boolean;
}

// the sidebar lives here, so the type its status note is typed by comes back
// out for the sidebar to import
export type { ShapesStatus } from "./components/MapPage";

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const { route, go } = useRoute();

  const viewport = useViewport();
  const drawer = sidebarIsDrawer(viewport.mode);
  const [sidebarOpen, setSidebarOpen] = useState(() => sidebarStartsOpen(viewport.mode));
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

  // a link can name a metro this build does not have. the address bar is
  // tidied the moment the data says so, rather than pointing at nothing
  useEffect(() => {
    if (!loaded) return;
    const known = new Set(loaded.data.metros.map((m) => m.cbsa));
    go((current) => pruneMetros(current, known));
  }, [loaded, go]);

  const indicators = useMemo(() => nationalIndicators(loaded?.data), [loaded]);
  const view = viewById(route.view);

  const shell: Shell = {
    drawer,
    open: sidebarOpen,
    condensed,
    width: sidebarWidth,
    setOpen: setSidebarOpen,
    resize: resizeSidebar,
    commit: commitSidebarWidth,
    reset: resetSidebar,
    measure: measureSidebar,
  };

  const className = [
    "app",
    drawer ? "layout-drawer" : "layout-docked",
    sidebarOpen ? "sidebar-open" : "sidebar-closed",
    condensed ? "sidebar-condensed" : "",
    `mode-${viewport.mode}`,
    `view-${view.id}`,
  ].filter(Boolean).join(" ");

  if (!loaded) {
    return (
      <div className={className}>
        <Header rate={null} sample={false} />
        <p style={{ padding: 16 }}>loading</p>
      </div>
    );
  }

  const View = view.component;
  const nav = (
    <ViewNav
      views={VIEWS}
      current={view.id}
      // the current search has to go in: writeParams only carries a key it does
      // not own when it is handed the string that key is in, and without it a
      // middle click or a copied link address loses whatever a view put there
      href={(id) => writeParams({ ...route, view: id }, window.location.search) || "?"}
      onChange={(id) => go({ view: id })}
    />
  );

  return (
    <div className={className}>
      <Header
        rate={loaded.data.national?.mortgage_rate ?? null}
        sample={loaded.sample}
        count={loaded.data.metros.length}
        indicators={indicators}
        updated={loaded.data.national?.indicators_updated ?? null}
        sidebarOpen={sidebarOpen}
        drawer={drawer}
        onToggleSidebar={view.id === "map" ? () => setSidebarOpen((open) => !open) : undefined}
        nav={nav}
      />
      <View data={loaded.data} route={route} go={go} viewport={viewport} shell={shell} />
    </div>
  );
}

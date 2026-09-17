import type { ComponentType } from "react";
import { AccuracyPage } from "../components/AccuracyPage";
import { ComparePage } from "../components/ComparePage";
import { ExplorePage } from "../components/ExplorePage";
import { MapPage } from "../components/MapPage";
import { ModelPage } from "../components/ModelPage";
import { SourcesPage } from "../components/SourcesPage";
import type { MapData } from "../types";
import type { Viewport } from "./layout";
import { VIEW_IDS, type Go, type RouteState, type ViewId } from "./route";

// the sidebar state the shell class names are built from. it lives in App,
// because those classes sit on the shell element itself, and it rides along
// with every view because the map is the view that draws the sidebar
export interface Shell {
  drawer: boolean;
  open: boolean;
  condensed: boolean;
  width: number | null;
  setOpen: (open: boolean) => void;
  resize: (width: number) => void;
  commit: (width: number) => void;
  reset: () => void;
  measure: () => number;
}

// everything a view is handed. a view draws the element under the header and
// owns whatever state only it cares about; anything shareable goes through go
export interface ViewProps {
  data: MapData;
  route: RouteState;
  go: Go;
  viewport: Viewport;
  shell: Shell;
}

// what the header nav needs, without the component behind it
export interface ViewTab {
  id: ViewId;
  label: string;
  title: string;
}

export interface ViewDef extends ViewTab {
  component: ComponentType<ViewProps>;
}

// to add a view: put its id in VIEW_IDS in route.ts and its entry here. the
// nav, the address bar and the back button all follow from those two, and
// tsc names the half that is missing when only one of them is done
const REGISTRY: Record<ViewId, ViewDef> = {
  map: { id: "map", label: "Map", title: "every metro on one map", component: MapPage },
  compare: { id: "compare", label: "Compare", title: "two to four metros side by side", component: ComparePage },
  explore: { id: "explore", label: "Explore", title: "any two metrics across every metro", component: ExplorePage },
  accuracy: { id: "accuracy", label: "Accuracy", title: "how the model's own past calls turned out", component: AccuracyPage },
  model: { id: "model", label: "Model", title: "how the forecast is built and judged", component: ModelPage },
  sources: { id: "sources", label: "Sources", title: "where every number comes from", component: SourcesPage },
};

// the map leads, so it is what an address with no view in it opens
export const VIEWS: ViewDef[] = VIEW_IDS.map((id) => REGISTRY[id]);

export function viewById(id: ViewId): ViewDef {
  return REGISTRY[id];
}

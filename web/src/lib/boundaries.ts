import type { Feature, Geometry } from "geojson";
import type { PathOptions } from "leaflet";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import type { Metro } from "../types";
import { INK, INK_2, NULL_GRAY, SURFACE } from "./palette";
import type { ColorScale } from "./scale";

export type MapMode = "dots" | "shapes";

export interface BoundaryProps {
  GEOID: string;
  NAME: string;
}

export type BoundaryFeature = Feature<Geometry, BoundaryProps>;

// the two topojson objects, each keyed by its five digit code
export interface BoundaryIndex {
  cbsa: Map<string, BoundaryFeature>;
  metdiv: Map<string, BoundaryFeature>;
}

export interface Shape {
  metro: Metro;
  feature: BoundaryFeature;
}

// one topojson object to features keyed by GEOID. a missing object gives an
// empty map rather than a throw, so a file with only cbsas still draws
function decodeObject(topology: Topology, name: string): Map<string, BoundaryFeature> {
  const out = new Map<string, BoundaryFeature>();
  const object = topology.objects[name] as GeometryCollection<BoundaryProps> | undefined;
  if (!object) return out;
  for (const f of feature(topology, object).features) {
    const code = f.properties?.GEOID;
    if (code) out.set(String(code), f as BoundaryFeature);
  }
  return out;
}

export function decodeBoundaries(topology: Topology): BoundaryIndex {
  return { cbsa: decodeObject(topology, "cbsa"), metdiv: decodeObject(topology, "metdiv") };
}

// a division draws its metdiv shape, everything else its cbsa shape. there is
// no cross lookup, so a division code never picks up a metro polygon
export function featureFor(metro: Pick<Metro, "cbsa" | "level">, index: BoundaryIndex): BoundaryFeature | null {
  const source = metro.level === "division" ? index.metdiv : index.cbsa;
  return source.get(metro.cbsa) ?? null;
}

// only the study's metros get a shape. codes in the file but not in the
// study are never drawn
export function studyShapes(metros: Metro[], index: BoundaryIndex): Shape[] {
  const shapes: Shape[] = [];
  for (const metro of metros) {
    const f = featureFor(metro, index);
    if (f) shapes.push({ metro, feature: f });
  }
  return shapes;
}

export const SHAPE_FILL_OPACITY = 0.72;
export const NULL_FILL_OPACITY = 0.35;
// a value the metro took from its parent. lighter than a measurement and
// heavier than nothing, because a 4px dot cannot show an outline pattern
export const INHERITED_FILL_OPACITY = 0.5;
// no data already owns "3 3" on the null gray, so this reads differently
export const INHERITED_DASH = "1 3";
// a value the build withheld. hollow like no data, since there is no number
// to colour, but ringed solid in ink, so a withheld rate and one nobody
// measured never look alike on the map
export const WITHHELD_FILL_OPACITY = 0.12;

// the outline, dash and fill a dot or shape wears for what its value is: a
// measurement, the parent's number, withheld, or nothing at all
export function markStyle(missing: boolean, taken: boolean, withheld: boolean): { color: string; dashArray: string | undefined; fillOpacity: number } {
  if (missing && withheld) return { color: INK_2, dashArray: undefined, fillOpacity: WITHHELD_FILL_OPACITY };
  if (missing) return { color: NULL_GRAY, dashArray: "3 3", fillOpacity: NULL_FILL_OPACITY };
  if (taken) return { color: INK_2, dashArray: INHERITED_DASH, fillOpacity: INHERITED_FILL_OPACITY };
  return { color: SURFACE, dashArray: undefined, fillOpacity: SHAPE_FILL_OPACITY };
}

// the fill a dot would get. a surface colored hairline is the gap between
// touching fills. null is gray, faint and dashed, so no data never rides on
// color alone. hover lifts the shape, the selected one wears the ink outline
export function shapeStyle(
  value: number | null,
  scale: ColorScale,
  state: { selected?: boolean; hover?: boolean; inherited?: boolean; withheld?: boolean } = {},
): PathOptions {
  const missing = value === null || !Number.isFinite(value);
  // an inherited number is real, so it keeps the colour of its value. only the
  // outline and the lighter fill say the measurement is the parent metro's.
  // with nothing to attribute the flag means nothing, and the same goes for a
  // withheld flag on a value that is there
  const taken = !missing && !!state.inherited;
  const withheld = missing && !!state.withheld;
  const mark = markStyle(missing, taken, withheld);
  const style: PathOptions = {
    fillColor: scale.color(value),
    fillOpacity: mark.fillOpacity,
    color: mark.color,
    weight: withheld ? 1.5 : 1,
    dashArray: mark.dashArray,
  };
  if (state.hover) {
    style.color = INK_2;
    style.weight = 1.5;
    style.fillOpacity = mark.fillOpacity + (missing ? 0.1 : 0.13);
  }
  if (state.selected) {
    style.color = INK;
    style.weight = 2.5;
    style.dashArray = undefined;
  }
  return style;
}

let cached: Promise<BoundaryIndex | null> | null = null;

// fetched once, the first time shapes are asked for. null when the file will
// not load, which the sidebar reports. only an index is kept: a dropped
// connection is not an answer, and caching it leaves the shapes view dead for
// the life of the page, so the cache is cleared and the next ask fetches again
export function loadBoundaries(): Promise<BoundaryIndex | null> {
  if (!cached) {
    cached = fetch(`${import.meta.env.BASE_URL}data/boundaries.json`)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return decodeBoundaries((await response.json()) as Topology);
      })
      .catch(() => {
        cached = null;
        return null;
      });
  }
  return cached;
}

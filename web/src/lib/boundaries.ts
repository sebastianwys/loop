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

// the fill a dot would get. a surface colored hairline is the gap between
// touching fills. null is gray, faint and dashed, so no data never rides on
// color alone. hover lifts the shape, the selected one wears the ink outline
export function shapeStyle(
  value: number | null,
  scale: ColorScale,
  state: { selected?: boolean; hover?: boolean; inherited?: boolean } = {},
): PathOptions {
  const missing = value === null || !Number.isFinite(value);
  // an inherited number is real, so it keeps the colour of its value. only the
  // outline and the lighter fill say the measurement is the parent metro's.
  // with nothing to attribute the flag means nothing
  const taken = !missing && !!state.inherited;
  const style: PathOptions = {
    fillColor: scale.color(value),
    fillOpacity: missing ? NULL_FILL_OPACITY : taken ? INHERITED_FILL_OPACITY : SHAPE_FILL_OPACITY,
    color: missing ? NULL_GRAY : taken ? INK_2 : SURFACE,
    weight: 1,
    dashArray: missing ? "3 3" : taken ? INHERITED_DASH : undefined,
  };
  if (state.hover) {
    style.color = INK_2;
    style.weight = 1.5;
    style.fillOpacity = missing ? NULL_FILL_OPACITY + 0.1 : taken ? INHERITED_FILL_OPACITY + 0.13 : SHAPE_FILL_OPACITY + 0.13;
  }
  if (state.selected) {
    style.color = INK;
    style.weight = 2.5;
    style.dashArray = undefined;
  }
  return style;
}

let cached: Promise<BoundaryIndex | null> | null = null;

// fetched once, the first time shapes are asked for. null when the file is
// missing, which the sidebar reports
export function loadBoundaries(): Promise<BoundaryIndex | null> {
  if (!cached) {
    cached = fetch(`${import.meta.env.BASE_URL}data/boundaries.json`)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return decodeBoundaries((await response.json()) as Topology);
      })
      .catch(() => null);
  }
  return cached;
}

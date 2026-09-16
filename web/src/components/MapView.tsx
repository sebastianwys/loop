import * as L from "leaflet";
import { useEffect, useMemo, useRef } from "react";
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap } from "react-leaflet";
import { formatValue } from "../lib/format";
import type { Metric } from "../lib/metrics";
import { INK, NULL_GRAY, SURFACE } from "../lib/palette";
import type { ColorScale } from "../lib/scale";
import { periodLabel } from "../lib/timeline";
import type { Metro } from "../types";
import { studyShapes, type BoundaryIndex, type MapMode } from "../lib/boundaries";
import { ShapeLayer } from "./ShapeLayer";

const CENTER: [number, number] = [39.5, -98.35];
const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// the lower 48 with a little margin. a fixed zoom drew the same span into
// every container, so a narrow window opened on the pacific with the
// country off the right edge
export const US_BOUNDS: L.LatLngBoundsExpression = [
  [24.0, -125.5],
  [49.6, -66.5],
];

// area proportional to population, clamped so small metros stay clickable
export function markerRadius(pop: number | null): number {
  if (pop === null || !Number.isFinite(pop) || pop <= 0) return 5;
  return Math.min(22, Math.max(4, 0.0072 * Math.sqrt(pop)));
}

// pan only when the selection is off screen, so clicking a marker does not move the map
function FlyTo({ metro, reducedMotion }: { metro: Metro | null; reducedMotion: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (!metro) return;
    const target = L.latLng(metro.lat, metro.lon);
    if (map.getBounds().contains(target)) return;
    const zoom = Math.max(map.getZoom(), 6);
    if (reducedMotion) map.setView(target, zoom, { animate: false });
    else map.flyTo(target, zoom, { duration: 0.6 });
  }, [map, metro, reducedMotion]);
  return null;
}

// the header grows when a national tile is opened and the drawer changes the
// width, so the map remeasures rather than drawing at the size it started
// with. it also refits the country until the reader moves the map themselves
function Fits() {
  const map = useMap();
  const moved = useRef(false);
  const fitting = useRef(false);

  useEffect(() => {
    const onMove = () => {
      if (!fitting.current) moved.current = true;
    };
    map.on("dragstart", onMove);
    map.on("zoomstart", onMove);
    return () => {
      map.off("dragstart", onMove);
      map.off("zoomstart", onMove);
    };
  }, [map]);

  useEffect(() => {
    const settle = () => {
      map.invalidateSize({ animate: false });
      if (moved.current) return;
      fitting.current = true;
      // the padding shrinks with the container so a phone does not spend
      // half its map on margin
      const box = map.getSize();
      const pad = Math.round(Math.min(24, Math.max(6, box.x * 0.02)));
      map.fitBounds(US_BOUNDS, { padding: [pad, pad], animate: false });
      window.setTimeout(() => {
        fitting.current = false;
      }, 0);
    };
    settle();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => settle());
    watch.observe(map.getContainer());
    return () => watch.disconnect();
  }, [map]);

  return null;
}

interface Props {
  metros: Metro[];
  metric: Metric;
  scale: ColorScale;
  selectedCbsa: string | null;
  onSelect: (cbsa: string) => void;
  mode: MapMode;
  boundaries: BoundaryIndex | null;
  reducedMotion?: boolean;
}

export function MapView({ metros, metric, scale, selectedCbsa, onSelect, mode, boundaries, reducedMotion = false }: Props) {
  // canvas with a hit tolerance so a 4px dot has a 24px target
  const renderer = useMemo(() => L.canvas({ tolerance: 8 }), []);
  // big metros first so small ones draw on top
  const ordered = useMemo(
    () => [...metros].sort((a, b) => (b.years?.["2024"]?.pop ?? 0) - (a.years?.["2024"]?.pop ?? 0)),
    [metros],
  );
  const selected = metros.find((m) => m.cbsa === selectedCbsa) ?? null;
  const signed = metric.kind === "diverging";
  // dots stay up until the shapes are decoded, then the layers swap, never both
  const shapes = useMemo(() => (boundaries ? studyShapes(metros, boundaries) : []), [metros, boundaries]);
  const drawShapes = mode === "shapes" && shapes.length > 0;

  return (
    <MapContainer center={CENTER} zoom={4} minZoom={3} renderer={renderer} preferCanvas scrollWheelZoom>
      <TileLayer attribution={OSM_ATTRIBUTION} url={OSM} />
      <Fits />
      {drawShapes && (
        <ShapeLayer shapes={shapes} metric={metric} scale={scale} selectedCbsa={selectedCbsa} onSelect={onSelect} />
      )}
      {!drawShapes && ordered.map((m) => {
        const value = metric.accessor(m);
        const missing = value === null;
        const isSelected = m.cbsa === selectedCbsa;
        return (
          <CircleMarker
            key={m.cbsa}
            center={[m.lat, m.lon]}
            radius={markerRadius(m.years?.["2024"]?.pop ?? null)}
            pathOptions={{
              color: isSelected ? INK : missing ? NULL_GRAY : SURFACE,
              weight: isSelected ? 3 : 2,
              dashArray: missing ? "3 3" : undefined,
              fillColor: scale.color(value),
              fillOpacity: missing ? 0.35 : 0.85,
            }}
            eventHandlers={{ click: () => onSelect(m.cbsa) }}
          >
            <Tooltip className="bs-tip" direction="top" offset={[0, -6]}>
              <span className="tn">{m.name}</span>{" "}
              <span className="tv">{formatValue(value, metric.format, signed)}</span>{" "}
              <span className="tp">{periodLabel(metric, m)}</span>
            </Tooltip>
          </CircleMarker>
        );
      })}
      <FlyTo metro={selected} reducedMotion={reducedMotion} />
    </MapContainer>
  );
}

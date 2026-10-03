import type { FeatureCollection, Geometry } from "geojson";
import * as L from "leaflet";
import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import { shapeStyle, type BoundaryProps, type Shape } from "../lib/boundaries";
import { WITHHELD, isInherited, withheldShort, withheldWhy } from "../lib/metrics";
import { formatValue } from "../lib/format";
import type { Metric } from "../lib/metrics";
import type { ColorScale } from "../lib/scale";
import { periodLabel } from "../lib/timeline";
import type { Metro } from "../types";

interface Props {
  shapes: Shape[];
  metric: Metric;
  scale: ColorScale;
  selectedCbsa: string | null;
  onSelect: (cbsa: string) => void;
}

// name, value and the period the value belongs to, in one line. built with
// textContent so a name is never parsed as html. a blank the build withheld
// says so, and a number a division took from its parent names the parent, the
// way the dot's tooltip does
export function tooltipContent(metro: Metro | undefined, metric: Metric): HTMLElement {
  const root = document.createElement("span");
  const n = document.createElement("span");
  n.className = "tn";
  n.textContent = metro?.name ?? "";
  const value = metro ? metric.accessor(metro) : null;
  const withheld = metro && value === null ? withheldWhy(metro, metric) : null;
  const v = document.createElement("span");
  v.className = "tv";
  v.textContent = withheld ? WITHHELD : formatValue(value, metric.format, metric.kind === "diverging");
  const p = document.createElement("span");
  p.className = "tp";
  p.textContent = metro ? `${periodLabel(metric, metro)}${withheld ? `, ${withheldShort(withheld)}` : ""}` : "";
  root.append(n, document.createTextNode(" "), v, document.createTextNode(" "), p);
  if (metro?.parent && value !== null && isInherited(metro, metric)) {
    const from = document.createElement("span");
    from.className = "tp";
    from.textContent = ` from ${metro.parent.name}`;
    root.append(from);
  }
  return root;
}

// true when the build withheld the blank this shape holds, which it wears
// differently from a blank nobody measured
function isWithheld(metro: Metro | undefined, metric: Metric): boolean {
  return !!metro && metric.accessor(metro) === null && withheldWhy(metro, metric) !== null;
}

// one leaflet geojson layer. created when the shapes change, restyled in
// place when the metric, scale or selection changes, so no polygon is rebuilt
// on a click. hover lifts a shape. the selected one is outlined and on top
export function ShapeLayer({ shapes, metric, scale, selectedCbsa, onSelect }: Props) {
  const map = useMap();
  const paths = useRef(new Map<string, L.Path>());
  // handlers read through this ref so they never see a stale metric or scale
  const current = useRef({ metric, scale, selectedCbsa, onSelect });
  current.current = { metric, scale, selectedCbsa, onSelect };

  useEffect(() => {
    const byCbsa = paths.current;
    const metroOf = new Map<string, Metro>(shapes.map((s) => [s.metro.cbsa, s.metro]));
    const style = (cbsa: string, hover = false): L.PathOptions => {
      const state = current.current;
      const metro = metroOf.get(cbsa);
      return shapeStyle(metro ? state.metric.accessor(metro) : null, state.scale, {
        selected: cbsa === state.selectedCbsa,
        hover,
        inherited: !!metro && isInherited(metro, state.metric),
        withheld: isWithheld(metro, state.metric),
      });
    };

    // the feature id carries the metro code so style and events can find it
    const collection: FeatureCollection<Geometry, BoundaryProps> = {
      type: "FeatureCollection",
      features: shapes.map((s) => ({ ...s.feature, id: s.metro.cbsa })),
    };
    const layer = L.geoJSON(collection, {
      style: (f) => style(String(f?.id ?? "")),
      onEachFeature: (f, l) => {
        const cbsa = String(f.id ?? "");
        const path = l as L.Path;
        const metro = metroOf.get(cbsa);
        byCbsa.set(cbsa, path);
        path.bindTooltip(tooltipContent(metro, metric), {
          className: "bs-tip",
          sticky: true,
          direction: "top",
          offset: [0, -6],
        });
        path.on("click", () => current.current.onSelect(cbsa));
        path.on("mouseover", () => path.setStyle(style(cbsa, true)));
        path.on("mouseout", () => path.setStyle(style(cbsa)));
      },
    }).addTo(map);

    return () => {
      layer.remove();
      byCbsa.clear();
    };
    // the tooltip and style are refreshed by the effect below, so only the
    // shapes themselves rebuild the layer
  }, [map, shapes]);

  useEffect(() => {
    const metroOf = new Map<string, Metro>(shapes.map((s) => [s.metro.cbsa, s.metro]));
    for (const [cbsa, path] of paths.current) {
      const metro = metroOf.get(cbsa);
      const value = metro ? metric.accessor(metro) : null;
      path.setStyle(shapeStyle(value, scale, {
        selected: cbsa === selectedCbsa,
        inherited: !!metro && isInherited(metro, metric),
        withheld: isWithheld(metro, metric),
      }));
      path.setTooltipContent(tooltipContent(metro, metric));
    }
    if (selectedCbsa) paths.current.get(selectedCbsa)?.bringToFront();
  }, [shapes, metric, scale, selectedCbsa]);

  return null;
}

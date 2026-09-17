import { useMemo } from "react";
import {
  buildExplore, exploreEnds, exploreOutliers, fitSentence, inheritedSentence, plotSize, plottedSentence,
  type ExplorePoint,
} from "../lib/explore";
import { exploreMetric, useExploreAxis } from "../lib/exploreRoute";
import { formatValue } from "../lib/format";
import { GROUPS, metricCaption, visibleDefs, type MetricDef } from "../lib/metrics";
import { routeMetric } from "../lib/route";
import type { ViewProps } from "../lib/views";
import type { Period } from "../types";
import { ExploreChart } from "./ExploreChart";
import "../styles/explore.css";

interface PickProps {
  id: string;
  axis: string;
  defs: MetricDef[];
  value: string;
  periods: Period[];
  period: Period | null;
  onMetric: (id: string) => void;
  onPeriod: (period: Period) => void;
}

function AxisPick({ id, axis, defs, value, periods, period, onMetric, onPeriod }: PickProps) {
  return (
    <div className="explore-axis">
      <label htmlFor={id}>{axis}</label>
      <select id={id} value={value} onChange={(e) => onMetric(e.target.value)}>
        {GROUPS.map((group) => {
          const members = defs.filter((d) => d.group === group);
          return members.length === 0 ? null : (
            <optgroup key={group} label={group}>
              {members.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </optgroup>
          );
        })}
      </select>
      {periods.length > 1 && (
        <div className="segmented" role="group" aria-label={`${axis} period`}>
          {periods.map((p) => (
            <button key={p} type="button" aria-pressed={p === period} onClick={() => onPeriod(p)}>{p}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// any two of the site's metrics, every metro one dot. the map colours one
// metric at a time and cannot answer a question about two, which is the whole
// reason this view exists
export function ExplorePage({ data, route, go, viewport }: ViewProps) {
  const metros = data.metros;
  const { axis, setAxis } = useExploreAxis();

  // the x axis is the route's own metric, the one the map is drawn in. the
  // second axis needs keys of its own, and they live in exploreRoute.ts
  const x = useMemo(() => routeMetric(route, metros), [route.metric, route.period, metros]);
  const y = useMemo(() => exploreMetric(axis, metros, x.def.id), [axis, metros, x.def.id]);
  const defs = useMemo(() => visibleDefs(metros), [metros]);
  const size = useMemo(() => plotSize(viewport.mode), [viewport.mode]);
  const model = useMemo(() => buildExplore(metros, x.metric, y.metric, size), [metros, x.metric, y.metric, size]);
  const ends = useMemo(() => exploreEnds(model), [model]);
  const outliers = useMemo(() => exploreOutliers(model), [model]);

  const xv = (v: number) => formatValue(v, x.metric.format, x.metric.kind === "diverging");
  const yv = (v: number) => formatValue(v, y.metric.format, y.metric.kind === "diverging");

  const rows: { end: string; point: ExplorePoint }[] = [
    ...ends.xHigh.map((point) => ({ end: "highest x", point })),
    ...ends.xLow.map((point) => ({ end: "lowest x", point })),
    ...ends.yHigh.map((point) => ({ end: "highest y", point })),
    ...ends.yLow.map((point) => ({ end: "lowest y", point })),
  ];

  // clicking a dot opens the metro the way every other view opens one, so the
  // map, the sidebar and the back button all follow it
  const pick = (cbsa: string) => go({ metro: cbsa === route.metro ? null : cbsa });

  return (
    <div className="explore-page">
      <div className="explore-inner">
        <div className="explore-head">
          <h2>Explore two metrics</h2>
          <p className="explore-note">
            Every metro in the build as one dot, the metric you choose across the bottom and the metric you choose
            up the side. The pair is in the address bar, so the link you copy opens what you are looking at.
          </p>
        </div>

        <div className="explore-controls">
          <AxisPick
            id="explore-x"
            axis="across the bottom"
            defs={defs}
            value={x.def.id}
            periods={x.available}
            period={x.period}
            onMetric={(id) => go({ metric: id })}
            onPeriod={(p) => go({ period: p })}
          />
          <AxisPick
            id="explore-y"
            axis="up the side"
            defs={defs}
            value={y.def.id}
            periods={y.available}
            period={y.period}
            onMetric={(id) => setAxis({ y: id, period: null })}
            onPeriod={(p) => setAxis({ period: p })}
          />
        </div>

        {model.points.length === 0 ? (
          <p className="explore-empty">
            No metro in this build carries both {x.metric.label} and {y.metric.label}, so there is nothing to draw.
          </p>
        ) : (
          <ExploreChart model={model} x={x.metric} y={y.metric} selected={route.metro} onPick={pick} />
        )}

        <ul className="explore-key" aria-label="what the marks mean">
          <li><span className="swatch dot" aria-hidden="true" />one metro</li>
          <li><span className="swatch taken" aria-hidden="true" />a division showing its parent metro's number</li>
          <li><span className="swatch spot" aria-hidden="true" />the metro that is open</li>
          {model.fit && <li><span className="swatch fit" aria-hidden="true" />the fitted line</li>}
        </ul>

        <div className="explore-facts">
          <p>{plottedSentence(model.counts, x.metric.label, y.metric.label)}</p>
          {model.counts.inherited > 0 && <p>{inheritedSentence(model.counts)}</p>}
          <p>{fitSentence(model, y.metric.label)}</p>
          {outliers.length > 0 && (
            <p>The line misses {outliers.map((p) => p.name).join(" and ")} by more than anywhere else on the plot.</p>
          )}
          <p className="explore-caution">
            Read this as two columns of one table sitting together, and nothing more. The 410 metros here are not 410
            independent samples: they share one mortgage rate, one national cycle and one set of federal rules, so
            when they move together a line through them can look far surer than the evidence is. Nothing on this page
            shows that either metric caused the other, and the pairs are yours to choose, so it is easy to land on a
            line that means nothing at all.
          </p>
        </div>

        {rows.length > 0 && (
          <div className="explore-scroll">
            <table className="explore-table">
              <caption>
                The ends of each axis. x is {x.metric.label}, y is {y.metric.label}. A metro that takes either number
                from a parent metro is left out, so one measurement cannot fill three rows under three names.
              </caption>
              <thead>
                <tr>
                  <th scope="col">end</th>
                  <th scope="col">metro</th>
                  <th scope="col" className="v">x</th>
                  <th scope="col" className="v">y</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.end}-${row.point.cbsa}`} className={row.point.cbsa === route.metro ? "open" : undefined}>
                    <td className="end">{row.end}</td>
                    <th scope="row">
                      <button type="button" onClick={() => pick(row.point.cbsa)}>{row.point.name}</button>
                    </th>
                    <td className="v">{xv(row.point.x)}</td>
                    <td className="v">{yv(row.point.y)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="explore-foot">
          Across the bottom: {metricCaption(x.metric, metros)}.
          {" "}Up the side: {metricCaption(y.metric, metros)}.
          {model.x.scale === "log" || model.y.scale === "log" ? " An axis marked in powers of ten is logarithmic: a metric that spans orders of magnitude leaves every metro but the largest few in one corner of a plain axis." : ""}
        </p>
      </div>
    </div>
  );
}

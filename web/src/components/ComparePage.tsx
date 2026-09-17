import { useMemo, useState } from "react";
import {
  MAX_COMPARE, MIN_COMPARE, buildCompare, chartSize, chooseMetros, toggleCompare, type CompareEntry,
} from "../lib/compare";
import { formatValue } from "../lib/format";
import { GROUPS, isInherited, visibleDefs } from "../lib/metrics";
import { searchMetros } from "../lib/rank";
import { routeMetric } from "../lib/route";
import { dateLabel } from "../lib/timeline";
import type { ViewProps } from "../lib/views";
import type { Metro } from "../types";
import { CompareChart, SeriesKey } from "./CompareChart";
import "../styles/compare.css";

const idx = (v: number | null) => formatValue(v, "index");

const seriesOf = (metro: Metro) => metro.series?.hpi ?? null;

// two to four metros, their price histories on one chart and the chosen
// metric beside them in a table. the metros are in the address bar, so a
// comparison is a link like everything else here
export function ComparePage({ data, route, go, viewport }: ViewProps) {
  const metros = data.metros;
  const [query, setQuery] = useState("");

  const chosen = useMemo(() => chooseMetros(route.compare, metros), [route.compare, metros]);
  // the metric turns on two fields of the route, and working out which
  // periods it publishes reads every metro
  const { metric, period, available } = useMemo(
    () => routeMetric(route, metros),
    [route.metric, route.period, metros],
  );
  const defs = useMemo(() => visibleDefs(metros), [metros]);
  const size = useMemo(() => chartSize(viewport.mode), [viewport.mode]);
  const entries = useMemo(
    () => chosen.reduce<CompareEntry[]>((out, metro) => {
      const series = seriesOf(metro);
      if (series) out.push({ cbsa: metro.cbsa, name: metro.name, series });
      return out;
    }, []),
    [chosen],
  );
  const model = useMemo(() => buildCompare(entries, size), [entries, size]);
  const results = useMemo(() => searchMetros(metros, query), [metros, query]);

  const full = chosen.length >= MAX_COMPARE;
  const enough = model.lines.length >= MIN_COMPARE;
  const signed = metric.kind === "diverging";
  const missing = chosen.filter((metro) => !seriesOf(metro));
  const asOf = entries.length > 0 ? dateLabel(entries[0].series.as_of) ?? entries[0].series.as_of : null;

  // the slot a metro wears comes off its line, never off where it sits in the
  // list: a metro with no history takes no slot, and the ones after it would
  // otherwise wear a key that belongs to somebody else's line
  const lineOf = (cbsa: string) => model.lines.find((line) => line.cbsa === cbsa) ?? null;

  const waiting = chosen.length === 0
    ? "Nothing to compare yet. Find a metro above, then another."
    : chosen.length >= MIN_COMPARE
      ? "Not enough price history here to draw a comparison."
      : "One more metro and this is a comparison.";

  const pick = (cbsa: string) => {
    go({ compare: toggleCompare(route.compare, cbsa) });
    setQuery("");
  };

  return (
    <div className="compare-page">
      <div className="compare-inner">
        <div className="compare-head">
          <h2>Compare metros</h2>
          <p className="compare-note">
            Two to four metros, their house price index on one chart and the metric you choose in the table.
            The address bar carries the comparison, so the link you copy opens what you are looking at.
          </p>
        </div>

        <div className="compare-card compare-pick">
          <label htmlFor="compare-search">add a metro</label>
          <input
            id="compare-search"
            type="search"
            placeholder={full ? "four is the most the chart holds" : "type a metro name"}
            value={query}
            autoComplete="off"
            disabled={full}
            onChange={(e) => setQuery(e.target.value)}
          />
          {results.length > 0 && (
            <ul className="results" id="compare-results">
              {results.map((metro) => (
                <li key={metro.cbsa}>
                  <button type="button" onClick={() => pick(metro.cbsa)}>
                    {metro.name}
                    {route.compare.includes(metro.cbsa) ? " (remove)" : ""}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {chosen.length > 0 && (
          <ul className="compare-chips" aria-label="the metros being compared">
            {chosen.map((metro) => {
              const line = lineOf(metro.cbsa);
              return (
                <li key={metro.cbsa}>
                  {line && <SeriesKey slot={line.slot} marker={line.marker} dash={line.dash} />}
                  {metro.name}
                  <button type="button" className="drop" aria-label={`remove ${metro.name}`} onClick={() => pick(metro.cbsa)}>x</button>
                </li>
              );
            })}
          </ul>
        )}

        {enough ? <CompareChart model={model} size={size} /> : <p className="compare-empty">{waiting}</p>}

        {missing.length > 0 && (
          <p className="compare-foot">
            No price history in this build for {missing.map((metro) => metro.name).join(", ")}, so there is nothing to draw for {missing.length === 1 ? "it" : "them"}.
          </p>
        )}

        <div className="compare-controls">
          <div>
            <label htmlFor="compare-metric">compare on</label>
            <select id="compare-metric" value={metric.def.id} onChange={(e) => go({ metric: e.target.value })}>
              {GROUPS.map((group) => {
                const members = defs.filter((d) => d.group === group);
                return members.length === 0 ? null : (
                  <optgroup key={group} label={group}>
                    {members.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </optgroup>
                );
              })}
            </select>
          </div>
          {available.length > 1 && (
            <div>
              <span className="label" id="compare-period">as of</span>
              <div className="segmented" role="group" aria-labelledby="compare-period">
                {available.map((p) => (
                  <button key={p} type="button" aria-pressed={p === period} onClick={() => go({ period: p })}>{p}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        {chosen.length > 0 && (
          <div className="compare-scroll">
            <table className="compare-table">
              <caption className="sr">{metric.label} and the house price index for the metros being compared</caption>
              <thead>
                <tr>
                  <th scope="col">metro</th>
                  <th scope="col" className="v">{metric.label}</th>
                  <th scope="col" className="v">house price index</th>
                  <th scope="col" className="v">{model.shared === null ? "growth" : `growth since ${model.shared}`}</th>
                </tr>
              </thead>
              <tbody>
                {chosen.map((metro) => {
                  const line = lineOf(metro.cbsa);
                  const value = metric.accessor(metro);
                  return (
                    <tr key={metro.cbsa}>
                      <th scope="row">
                        <span className="name">
                          {line && <SeriesKey slot={line.slot} marker={line.marker} dash={line.dash} />}
                          {metro.name}
                        </span>
                      </th>
                      <td className="v">
                        {formatValue(value, metric.format, signed)}
                        {value !== null && isInherited(metro, metric) && <span className="taken">from the parent</span>}
                      </td>
                      <td className="v">
                        {line ? idx(line.last.value) : "-"}
                        {line && <span className="date">{line.last.year}</span>}
                      </td>
                      <td className="v">{line ? formatValue(line.growth, "rate", true) : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="compare-foot">
          House prices: FHFA House Price Index, annual mean{asOf ? `, the last year through ${asOf}` : ""}.
          {" "}Growth is measured from the first year every metro here has an index.
        </p>
      </div>
    </div>
  );
}

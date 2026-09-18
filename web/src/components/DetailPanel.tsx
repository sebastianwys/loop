import { useMemo } from "react";
import { footprintNote, geoNote, inheritedFrom, parentMetricsNote } from "../lib/geo";
import { forecastExplainer, forecastLines } from "../lib/forecast";
import { formatValue } from "../lib/format";
import { forecastOf } from "../lib/history";
import { DEFS, GROUPS, defDate, type MetricDef } from "../lib/metrics";
import { dateLabel, laterStartsNote, latestColumn, publishedPeriods } from "../lib/timeline";
import type { AnnualSeries, Growth, Metro, Period, YearKey } from "../types";
import { Explainer } from "./Explainer";
import { HistoryChart } from "./HistoryChart";
import { InlineSpark, Sparkline } from "./Sparkline";

const YEARS: YearKey[] = ["2014", "2019", "2024"];

const GROWTH: { key: keyof Growth; label: string }[] = [
  { key: "hpi_14_19", label: "HPI, 2014 to 2019" },
  { key: "hpi_19_24", label: "HPI, 2019 to 2024" },
  { key: "income_14_24", label: "Median income, 2014 to 2024" },
  { key: "home_value_14_24", label: "Median home value, 2014 to 2024" },
  { key: "pop_14_24", label: "Population, 2014 to 2024" },
];

// the definitions in a group that are read by year and have a value in at
// least one of this metro's panels, so an uncollected source adds no rows
export function yearRows(metro: Metro, group: string): MetricDef[] {
  return DEFS.filter(
    (d) => d.group === group && d.periods.some((p) => p !== "latest") && YEARS.some((y) => d.valueAt(metro, y) !== null),
  );
}

// definitions with a latest value for this metro. the forecasts have a
// section of their own, with the bands
export function latestRows(metro: Metro): MetricDef[] {
  return DEFS.filter((d) => d.group !== "Forecasts" && d.periods.includes("latest") && d.valueAt(metro, "latest") !== null);
}

// one line under the chart: what the points are and where the last one ends.
// a short newest year is not an annual mean, so it says what that point is
export function historyNote(series: AnnualSeries, forecast: boolean): string {
  const lastYear = series.start + series.values.length - 1;
  const asOf = dateLabel(series.as_of) ?? series.as_of;
  const base = series.partial_year
    ? `Annual mean of the index, through ${series.partial_year - 1}; the last point is the index at ${asOf}, not a full year.`
    : `Annual mean of the index, through ${lastYear}.`;
  return forecast ? `${base} Dashed line and band: the model's expected path with its 90 percent band.` : base;
}

interface CellProps {
  def: MetricDef;
  metro: Metro;
  period: Period;
  published: Period[];
  date: string | null;
}

// a period the measure is not published at reads as a muted dash with the
// reason on hover; a published period this metro lacks keeps the plain dash
function Cell({ def, metro, period, published, date }: CellProps) {
  if (!published.includes(period)) {
    return (
      <td className="np" title="not published for this period">
        <span aria-hidden="true">-</span>
        <span className="sr">not published</span>
      </td>
    );
  }
  const value = def.valueAt(metro, period);
  if (value === null) return <td title="no value for this metro">-</td>;
  return (
    <td>
      {formatValue(value, def.format, def.kind === "diverging")}
      {date && <span className="date">{date}</span>}
    </td>
  );
}

interface Props {
  metro: Metro;
  metros: Metro[];
  onClose: () => void;
}

export function DetailPanel({ metro, metros, onClose }: Props) {
  const published = useMemo(() => publishedPeriods(metros), [metros]);
  const hpi = YEARS.map((y) => metro.years?.[y]?.hpi ?? null);
  const history = metro.series?.hpi ?? null;
  const forecast = forecastOf(metro);
  const forecasts = forecastLines(metro);
  const explainer = forecastExplainer(metro);
  const inherited = parentMetricsNote(metro);
  const footprint = footprintNote(metro);
  // a measure in a vintage table shows its latest value there already
  const shown = new Set(GROUPS.flatMap((group) => yearRows(metro, group).map((d) => d.id)));
  const latest = latestRows(metro).filter((d) => !shown.has(d.id));

  return (
    <aside className="detail" aria-label={`${metro.name} detail`}>
      <header>
        <h2>{metro.name}</h2>
        {geoNote(metro) && <p className="geo-note">{geoNote(metro)}</p>}
        <button className="close" aria-label="close detail" onClick={onClose}>
          x
        </button>
      </header>

      <h3>
        House price index, all transactions
        {history && <Explainer label="this chart">{historyNote(history, forecast !== null)}</Explainer>}
      </h3>
      {history ? (
        <HistoryChart series={history} forecast={forecast} name={metro.name} />
      ) : (
        <Sparkline values={hpi} labels={YEARS} title={`house price index for ${metro.name}, 2014, 2019 and 2024`} />
      )}

      {GROUPS.map((group) => {
        const rows = yearRows(metro, group);
        if (rows.length === 0) return null;
        const column = latestColumn(metro, rows);
        const columns: Period[] = column.show ? [...YEARS, "latest"] : YEARS;
        const note = laterStartsNote(rows.map((d) => ({
          label: d.label, periods: published[d.id] ?? d.periods, source: d.source,
        })));
        return (
          <details key={group} open={group === "House prices"}>
            <summary>
              {group}, by vintage year
              {note && <Explainer label={`the ${group.toLowerCase()} table`}>{note}</Explainer>}
            </summary>
            <table className="vintage">
              <thead>
                <tr>
                  <th>measure</th>
                  <th className="trend">trend</th>
                  {YEARS.map((y) => <th key={y}>{y}</th>)}
                  {column.show && (
                    <th>
                      latest
                      <span className="date">{column.header ?? "by source"}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const periods = published[d.id] ?? d.periods;
                  const labels = periods.map((p) => (p === "latest" ? (column.dates[d.id] ?? "latest") : p));
                  return (
                    <tr key={d.id}>
                      <td>
                        {d.label}
                        {inheritedFrom(metro, d) && <span className="date">{inheritedFrom(metro, d)}</span>}
                      </td>
                      <td className="trend">
                        <InlineSpark values={periods.map((p) => d.valueAt(metro, p))} labels={labels} format={d.format} signed={d.kind === "diverging"} />
                      </td>
                      {columns.map((p) => (
                        <Cell
                          key={p}
                          def={d}
                          metro={metro}
                          period={p}
                          published={periods}
                          date={p === "latest" && !column.header ? (column.dates[d.id] ?? null) : null}
                        />
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>
        );
      })}

      <h3>Change</h3>
      <table>
        <tbody>
          {GROWTH.map((g) => (
            <tr key={g.key}>
              <td>{g.label}</td>
              <td>{formatValue(metro.growth?.[g.key] ?? null, "pct", true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {footprint && <p className="geo-note">{footprint}</p>}

      {forecasts.length > 0 && (
        <>
          <h3>
            Forecasts
            <Explainer label="these forecasts">
              {explainer.sentences.join(" ")}
              <span className="explainer-source">{explainer.source}</span>
            </Explainer>
          </h3>
          <table>
            <tbody>
              {forecasts.map((line) => (
                <tr key={line.id}>
                  <td>{line.label}</td>
                  <td>{line.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {latest.length > 0 && (
        <>
          <h3>Latest</h3>
          <table>
            <tbody>
              {latest.map((d) => (
                <tr key={d.id}>
                  <td>
                    {d.label}
                    {inheritedFrom(metro, d) && <span className="date">{inheritedFrom(metro, d)}</span>}
                  </td>
                  <td>{formatValue(d.valueAt(metro, "latest"), d.format, d.kind === "diverging")}</td>
                  <td>{dateLabel(defDate(d, metro, "latest"), d.source) ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {inherited && <p className="geo-note">{inherited}</p>}
    </aside>
  );
}

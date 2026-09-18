import { useMemo, useState } from "react";
import { browserHost, csvFilename, downloadCsv, rankingCsv } from "../lib/csv";
import { formatValue } from "../lib/format";
import { GROUPS, type Metric, type MetricDef, metricExplainer } from "../lib/metrics";
import { rankMetros, searchMetros } from "../lib/rank";
import type { ColorScale } from "../lib/scale";
import type { Metro, Period, Sources } from "../types";
import type { MapMode } from "../lib/boundaries";
import type { ShapesStatus } from "../App";
import { Explainer } from "./Explainer";
import { Timeline } from "./Timeline";

interface Props {
  metros: Metro[];
  defs: MetricDef[];
  metric: Metric;
  period: Period | null;
  available: Period[];
  scale: ColorScale;
  selectedCbsa: string | null;
  sources: Sources;
  generatedAt: string;
  onMetricChange: (id: string) => void;
  onPeriodChange: (period: Period) => void;
  onSelect: (cbsa: string) => void;
  mode: MapMode;
  shapesStatus: ShapesStatus;
  onModeChange: (mode: MapMode) => void;
  drawer?: boolean;
  // dragged narrow enough that the headings say the short thing. the css
  // handles the spacing, this is only for the text that would otherwise wrap
  condensed?: boolean;
  onClose?: () => void;
}

const SHAPES_NOTE: Partial<Record<ShapesStatus, string>> = {
  loading: "loading shapes",
  failed: "shapes did not load. switch to dots and back to try again, or run npm run boundaries if the file is missing",
};

// the attribution each source asks for, in the footer once per source present
const CREDITS: [string, string][] = [
  ["fhfa", "House prices: FHFA House Price Index."],
  ["census", "Demographics: U.S. Census Bureau, ACS 5-year estimates."],
  ["acs", "Rents, poverty, commute and labor force: U.S. Census Bureau, ACS 5-year estimates."],
  ["pep", "Population and migration components: U.S. Census Bureau, Population Estimates Program."],
  ["bps", "Permits: U.S. Census Bureau, Building Permits Survey."],
  ["irs", "Tax return migration: IRS Statistics of Income."],
  ["zillow", "Home values, rents, inventory and forecasts: Data provided by Zillow Research."],
  ["realtor", "Listings: Realtor.com Economic Research."],
  ["bls", "Unemployment: U.S. Bureau of Labor Statistics, LAUS."],
  ["fred", "Mortgage rates: FRED, Federal Reserve Bank of St. Louis."],
  ["bea", "Personal income: U.S. Bureau of Economic Analysis."],
  ["hud", "Fair market rents and income limits: HUD User. HUD publishes for its own fmr areas, so a metro it has no area for is the population weighted mean of the areas its counties sit in."],
  ["forecast", "Forecasts: Loop model, fit on the sources above."],
];

export function Sidebar({
  metros, defs, metric, period, available, scale, selectedCbsa, sources, generatedAt,
  onMetricChange, onPeriodChange, onSelect, mode, shapesStatus, onModeChange,
  drawer = false, condensed = false, onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [showAll, setShowAll] = useState(false);

  const results = useMemo(() => searchMetros(metros, query), [metros, query]);
  // the whole ranking is sorted once: the list shows a slice of it, and the
  // export writes all of it, so the file is the ranking the reader is looking
  // at rather than the fifteen rows that happen to be on screen
  const all = useMemo(() => rankMetros(metros, metric), [metros, metric]);
  const ranked = showAll ? all : all.slice(0, 15);
  const signed = metric.kind === "diverging";
  const present = new Set(Object.keys(sources).concat(["fhfa", "census"]));
  if (sources.zillow) present.add("zillow");

  const pick = (metro: Metro) => {
    onSelect(metro.cbsa);
    setQuery("");
    setActive(0);
  };

  const exportCsv = () => {
    const host = browserHost();
    if (host === null) return;
    // metric.period, not the route's: it is the period the values were read
    // at, so the name cannot promise a panel the numbers did not come from
    // the resolved label already carries the period, so it is not passed twice
    downloadCsv(rankingCsv(all, metric), csvFilename(metric.label, null), host);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[Math.min(active, results.length - 1)]);
    } else if (e.key === "Escape") {
      setQuery("");
    }
  };

  return (
    <aside className="sidebar" id="controls" aria-label="map controls">
      {drawer && onClose && (
        <div className="sidebar-head">
          <h2>Controls</h2>
          <button type="button" className="close" aria-label="close the controls" onClick={onClose}>x</button>
        </div>
      )}
      <div>
        <span className="label" id="mode-label">draw metros as</span>
        <div className="segmented" role="group" aria-labelledby="mode-label">
          <button type="button" aria-pressed={mode === "dots"} onClick={() => onModeChange("dots")}>Dots</button>
          <button type="button" aria-pressed={mode === "shapes"} onClick={() => onModeChange("shapes")}>Shapes</button>
        </div>
        {mode === "shapes" && SHAPES_NOTE[shapesStatus] && <p className="mode-note" role="status">{SHAPES_NOTE[shapesStatus]}</p>}
      </div>

      <div>
        <label htmlFor="metric">
          color metros by
          <Explainer label="this metric">{metricExplainer(metric)}</Explainer>
        </label>
        <select id="metric" value={metric.def.id} onChange={(e) => onMetricChange(e.target.value)}>
          {GROUPS.map((group) => {
            const members = defs.filter((d) => d.group === group);
            return members.length === 0 ? null : (
              <optgroup key={group} label={group}>
                {members.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </div>

      <Timeline def={metric.def} metros={metros} period={period} available={available} onPeriodChange={onPeriodChange} />

      <div>
        <label htmlFor="search">find a metro</label>
        <input
          id="search"
          type="search"
          placeholder={condensed ? "metro name" : "type a metro name"}
          value={query}
          autoComplete="off"
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          aria-controls="search-results"
        />
        {results.length > 0 && (
          <ul className="results" id="search-results">
            {results.map((m, i) => (
              <li key={m.cbsa}>
                <button type="button" className={i === active ? "active" : ""} onClick={() => pick(m)}>
                  {m.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rank">
        <h2>
          {showAll ? `all ${ranked.length} metros` : "top 15"}
          {condensed ? "" : ` by ${metric.label.toLowerCase()}`}
        </h2>
        {showAll ? (
          <div className="table-all">
            <table>
              <thead>
                <tr><th>#</th><th>metro</th><th className="v">value</th></tr>
              </thead>
              <tbody>
                {ranked.map((r, i) => (
                  <tr key={r.metro.cbsa}>
                    <td>{i + 1}</td>
                    <td><button type="button" onClick={() => onSelect(r.metro.cbsa)}>{r.metro.name}</button></td>
                    <td className="v">{formatValue(r.value, metric.format, signed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ol>
            {ranked.map((r, i) => (
              <li key={r.metro.cbsa}>
                <button
                  type="button"
                  className={r.metro.cbsa === selectedCbsa ? "selected" : ""}
                  onClick={() => onSelect(r.metro.cbsa)}
                >
                  <span className="n">{i + 1}</span>
                  <span>
                    <span className="swatch" style={{ background: scale.color(r.value) }} aria-hidden="true" />
                    {r.metro.name}
                  </span>
                  <span className="v">{formatValue(r.value, metric.format, signed)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
        <button type="button" className="linkish" onClick={() => setShowAll((s) => !s)}>
          {showAll ? "show top 15" : condensed ? "show all" : "show all as a table"}
        </button>
        {/* hidden rather than disabled: linkish has no disabled look, and a
            metric nothing publishes has no ranking to hand over */}
        {all.length > 0 && (
          <>
            {" "}
            <button
              type="button"
              className="linkish"
              aria-label={`download all ${all.length} metros ranked by ${metric.label.toLowerCase()} as a csv file`}
              onClick={exportCsv}
            >
              download csv
            </button>
          </>
        )}
      </div>

      <footer className="footer">
        <p>
          Vintages: {Object.entries(sources).map(([name, version]) => `${name} ${version ?? "not loaded"}`).join("; ")}. Built {generatedAt}.
        </p>
        <p>
          {CREDITS.filter(([source]) => present.has(source)).map(([, line]) => line).join(" ")}
          {" "}Tiles: OpenStreetMap contributors.
        </p>
      </footer>
    </aside>
  );
}

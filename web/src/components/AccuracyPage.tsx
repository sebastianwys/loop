import { useMemo, useRef, useState } from "react";
import {
  MIN_STATE, NORMAL_TAIL, barAt, buildHistogram, buildScatter, chartBox, collectMisses, coverage,
  extremes, grownTo, histogramTitle, largerSide, nearestMetro, openMetro, originOf, scatterTitle, sizeFit, stance,
  stateSpread, summarize,
  type HistogramBar, type Miss, type ScatterPoint,
} from "../lib/accuracy";
import { formatValue } from "../lib/format";
import { FIT_END, NOMINAL_COVERAGE, SHIPPED, quarterLabel, rowAt, scored } from "../lib/model";
import { BACKTEST } from "../lib/modelNumbers";
import { dateLabel } from "../lib/timeline";
import type { Go } from "../lib/route";
import type { ViewProps } from "../lib/views";
import "../styles/accuracy.css";

// the miss is a gap between two growth rates, so it is in percentage points,
// and the growth rates either side of it are percents. the two never wear the
// same suffix on this page, because confusing them is the whole trap
const pp = (v: number | null, signed = true) => {
  if (v === null || !Number.isFinite(v)) return "-";
  // a value that rounds to zero must not print as a signed zero, which reads
  // as a direction the number does not have
  const shown = Number(v.toFixed(1));
  return `${signed && shown > 0 ? "+" : ""}${(shown === 0 ? 0 : shown).toFixed(1)} pp`;
};

const pct = (v: number | null) => formatValue(v, "rate", true);

const share = (v: number) => `${Math.round(v * 100)}%`;

// two shares a whole point apart both round to the same whole number, so the
// pair being compared gets a decimal
const share1 = (v: number) => `${(v * 100).toFixed(1)}%`;

const HOW_MANY = 8;

function Tile({ value, label, note }: { value: string; label: string; note: string }) {
  return (
    <div className="acc-tile">
      <span className="v">{value}</span>
      <span className="l">{label}</span>
      <span className="n">{note}</span>
    </div>
  );
}

// the same row shape in both directions, with the metro a link to itself on
// the map. realized and expected sit beside the miss so the subtraction on
// every row can be checked without leaving the page
function MissTable({ rows, caption, empty, go }: { rows: Miss[]; caption: string; empty: string; go: Go }) {
  if (rows.length === 0) return <p className="acc-empty">{empty}</p>;
  return (
    <div className="acc-scroll">
      <table className="acc-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">metro</th>
            <th scope="col" className="v">it grew</th>
            <th scope="col" className="v">model said</th>
            <th scope="col" className="v">miss</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.cbsa}>
              <th scope="row">
                <button type="button" className="acc-link" onClick={() => go(openMetro(row.cbsa))}>
                  {row.name}
                </button>
              </th>
              <td className="v">{pct(row.realized)}</td>
              <td className="v">{pct(row.expected)}</td>
              <td className={`v ${row.surprise < 0 ? "over" : "under"}`}>{pp(row.surprise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// the model's own scorecard: how far its last out of sample call was from
// what happened, in every metro it covers, and what that is worth
export function AccuracyPage({ data, go, viewport }: ViewProps) {
  const metros = data.metros;
  const size = useMemo(() => chartBox(viewport.mode), [viewport.mode]);
  const misses = useMemo(() => collectMisses(metros), [metros]);
  const seen = useMemo(() => coverage(metros, misses), [metros, misses]);
  const stats = useMemo(() => summarize(misses), [misses]);
  const worst = useMemo(() => extremes(misses, HOW_MANY), [misses]);
  const spread = useMemo(() => stateSpread(misses), [misses]);
  const hist = useMemo(() => buildHistogram(misses, size.width, size.height, size.step), [misses, size]);
  const cloud = useMemo(() => buildScatter(misses, size.width, size.height), [misses, size]);
  const now = useMemo(() => stance(metros), [metros]);
  const size4 = useMemo(() => sizeFit(misses), [misses]);
  const origin = useMemo(() => originOf(metros), [metros]);
  const grown = useMemo(() => grownTo(metros), [metros]);

  const [bar, setBar] = useState<HistogramBar | null>(null);
  const [dot, setDot] = useState<ScatterPoint | null>(null);
  const histSvg = useRef<SVGSVGElement>(null);
  const cloudSvg = useRef<SVGSVGElement>(null);

  // svg user units from a client position, so the readout follows the pointer
  // at whatever width the chart was scaled to
  const inside = (svg: SVGSVGElement | null, e: { clientX: number; clientY: number }) => {
    const box = svg?.getBoundingClientRect();
    if (!box || box.width === 0) return null;
    return { x: ((e.clientX - box.left) * size.width) / box.width, y: ((e.clientY - box.top) * size.height) / box.height };
  };

  const stepDot = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const order = [...cloud.points].sort((a, b) => a.error - b.error);
    if (order.length === 0) return;
    const at = dot === null ? -1 : order.findIndex((p) => p.cbsa === dot.cbsa);
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + step));
    setDot(order[next]);
  };

  if (stats === null) {
    return (
      <div className="accuracy-page">
        <div className="accuracy-inner">
          <div className="acc-head">
            <h2>How far the model missed</h2>
          </div>
          <p className="acc-empty">
            No scored forecasts in this build. The page fills in once the model exports a surprise for each metro,
            which needs a backtest run behind the live forecast.
          </p>
        </div>
      </div>
    );
  }

  // every verdict on this page is read off the number beside it, so a build
  // whose data moves cannot leave the prose asserting the old direction
  const ran = stats.median < 0 ? "high" : "low";
  const fit = cloud.fit;
  const bins = cloud.marks;
  const asOf = dateLabel(origin) ?? origin;
  const until = dateLabel(grown) ?? grown;
  const repeat = now === null ? null : now.median + stats.median;
  const tail = stats.p95 - stats.p05;
  const skewWord = stats.skew > 0 ? "positive" : stats.skew < 0 ? "negative" : "flat";
  // skewness is measured about the average miss, so it says which way the
  // misses spread from that average. which side of the call missed by more is
  // a different question, measured from zero, and read off the two sides
  const skewReading = stats.skew > 0
    ? "misses above the average miss run further out than misses below it"
    : stats.skew < 0
      ? "misses below the average miss run further out than misses above it"
      : "misses spread about as far either side of the average miss";
  const larger = largerSide(stats.beats, stats.shortfalls);
  const sides = stats.beats.mean !== null && stats.shortfalls.mean !== null && stats.beats.max !== null && stats.shortfalls.max !== null
    ? { beat: stats.beats.mean, short: stats.shortfalls.mean, beatMax: stats.beats.max, shortMax: stats.shortfalls.max }
    : null;
  const whichSide = sides === null
    ? ""
    : larger === "shortfalls"
      ? ` Measured from the call, the metros that fell short missed by more than the metros that beat it: ${sides.short.toFixed(2)} points on average against ${sides.beat.toFixed(2)}, and ${sides.shortMax.toFixed(2)} at the worst against ${sides.beatMax.toFixed(2)}.`
      : larger === "beats"
        ? ` Measured from the call, the metros that beat it missed by more than the metros that fell short: ${sides.beat.toFixed(2)} points on average against ${sides.short.toFixed(2)}, and ${sides.beatMax.toFixed(2)} at the worst against ${sides.shortMax.toFixed(2)}.`
        : ` Measured from the call, neither side missed by more on both counts: the metros that beat it did by ${sides.beat.toFixed(2)} points on average and ${sides.beatMax.toFixed(2)} at the worst, the ones that fell short by ${sides.short.toFixed(2)} and ${sides.shortMax.toFixed(2)}.`;
  // the scored calls are the backtest's, and the coverage the band section
  // quotes is the backtest band's. the band on the map is the shipped one,
  // with a margin set separately, so the page says whose number it is
  const made = quarterLabel(origin);
  const backtest4 = rowAt(BACKTEST, SHIPPED, 4);
  const cover4 = backtest4 && scored(backtest4.coverage) ? backtest4.coverage : null;
  const tailWord = stats.kurtosis > 0 ? "fatter tails than a normal curve" : stats.kurtosis < 0 ? "thinner tails than a normal curve" : "tails about as heavy as a normal curve";
  // the test the lean is judged by, stated on the page rather than assumed:
  // is the average miss further from zero than twice the standard error that
  // lets metros in a state move together
  const errorBar = spread === null ? stats.se : spread.clusterSe;
  const leaning = Math.abs(stats.mean) > 2 * errorBar;
  const holds = fit === null ? "" : fit.r >= 0.5 ? "It holds, and clearly."
    : fit.r >= 0.2 ? "It holds, weakly."
      : fit.r > -0.2 ? "It barely holds at all."
        : "It runs the other way from the guess.";
  // whether the miss grows at every step of the error, or only at one end
  const steady = bins.length > 1 && bins.every((bin, i) => i === 0 || bin.meanAbs > bins[i - 1].meanAbs);
  const clusterMoves = spread === null ? "leaves" : spread.clusterSe > stats.se ? "widens" : spread.clusterSe < stats.se ? "narrows" : "leaves";
  // a band that hands out one width to every metro says nothing about any one
  // of them. the line drawn here is a width that varies by less than a quarter
  // of itself across every metro in the build
  const flatBand = now !== null && now.bandWidth !== null && now.bandMin !== null && now.bandMax !== null
    && now.bandMax - now.bandMin < now.bandWidth / 4;

  return (
    <div className="accuracy-page">
      <div className="accuracy-inner">
        <div className="acc-head">
          <h2>How far the model missed</h2>
          <p className="acc-note">
            These are the backtest's calls: the sequence GRU, fit on outcomes through {FIT_END}, forecasting four
            quarter growth for every metro from the {made ?? "scored"} origin. Those quarters have now happened,
            and none of them was in training. The miss is what the metro grew minus what the model said. The
            forecast on the map is a refit with no scored calls yet.
          </p>
        </div>

        <div className="acc-tiles">
          <Tile value={String(stats.n)} label="calls scored" note={`of ${seen.metros} metros`} />
          <Tile value={pp(stats.mae, false)} label="typical miss" note="mean absolute, either way" />
          <Tile value={pp(stats.median)} label="middle metro" note={`the model ran ${ran}`} />
          <Tile value={share(stats.high)} label="came in under" note="grew less than expected" />
        </div>

        <section className="acc-block">
          <h3>1. How far off, and which way</h3>
          <p>
            The middle metro grew {pp(stats.median)} against what the model expected, and {share(stats.high)} of the
            {" "}{stats.n} scored metros came in under their forecast. A model with no lean would put about half on
            each side.
          </p>
          <p>
            {leaning ? (
              <>
                The model ran {ran} across the map, a lean rather than bad luck in a few places. The average miss
                of {pp(stats.mean)} is more than twice its {errorBar.toFixed(2)} point standard error
                {spread !== null ? ", even with metros in a state allowed to move together (section 4)" : ""}.
              </>
            ) : (
              <>
                That is not enough to call a lean from this origin. The average miss of {pp(stats.mean)} sits inside
                twice its {errorBar.toFixed(2)} point standard error
                {spread !== null ? ", with metros in a state allowed to move together" : ""}, so one national year could
                produce it by itself.
              </>
            )}
          </p>
          <p>
            The miss is not symmetric either. Skewness is {stats.skew.toFixed(2)}, {skewWord}, so {skewReading}.
            {whichSide} Excess kurtosis is {stats.kurtosis.toFixed(2)}, {tailWord}: {share1(stats.outliers)} of
            metros sit more than two standard deviations out, against {share1(NORMAL_TAIL)} for a normal curve.
          </p>

          <figure className="acc-figure">
            <svg
              ref={histSvg}
              className="acc-chart acc-hist"
              width={size.width}
              height={size.height}
              viewBox={`0 0 ${size.width} ${size.height}`}
              role="img"
              aria-label={histogramTitle(stats)}
              tabIndex={0}
              onMouseMove={(e) => {
                const at = inside(histSvg.current, e);
                setBar(at === null ? null : barAt(hist, at.x));
              }}
              onMouseLeave={() => setBar(null)}
              onBlur={() => setBar(null)}
            >
              <title>{histogramTitle(stats)}</title>
              {hist.yTicks.map((t) => (
                <g key={t.value}>
                  <line className="grid" x1={hist.left} x2={hist.right} y1={t.y} y2={t.y} />
                  <text className="lbl" x={hist.left - 6} y={t.y + 3} textAnchor="end">{t.value}</text>
                </g>
              ))}
              {hist.bars.map((b) => (
                <rect
                  key={b.from}
                  className={`bar ${b.side}${bar !== null && bar.from === b.from ? " on" : ""}`}
                  x={b.x}
                  y={b.y}
                  width={b.w}
                  height={b.h}
                  rx={2}
                />
              ))}
              <line className="zero" x1={hist.zeroX} x2={hist.zeroX} y1={hist.top} y2={hist.bottom} />
              {hist.medianX !== null && (
                <g className="median">
                  <line x1={hist.medianX} x2={hist.medianX} y1={hist.top} y2={hist.bottom} />
                  <text className="lbl" x={hist.medianX - 4} y={hist.top + 9} textAnchor="end">median</text>
                </g>
              )}
              {/* a row below the median label, which sits close to it whenever the model was nearly right */}
              <text className="lbl" x={hist.zeroX + 4} y={hist.top + 21}>0, the model was right</text>
              {hist.xTicks.map((t) => (
                <text key={t.value} className="lbl" x={t.x} y={hist.bottom + 14} textAnchor="middle">{t.value}</text>
              ))}
              <text className="side" x={hist.left - 26} y={hist.top - 12} textAnchor="start">metros</text>
              <text className="side" x={hist.left} y={size.height - 6} textAnchor="start">model ran high</text>
              <text className="side" x={hist.right} y={size.height - 6} textAnchor="end">model ran low</text>
            </svg>
            <p className="acc-readout" aria-live="polite">
              {bar === null ? (
                <span className="hint">point at a bar to read it. misses counted in {hist.step} point bins</span>
              ) : (
                <span>
                  <strong>{bar.count}</strong> {bar.count === 1 ? "metro" : "metros"} missed by {bar.from.toFixed(0)} to
                  {" "}{bar.to.toFixed(0)} points, the model running {bar.side === "over" ? "high" : "low"} there
                </span>
              )}
            </p>
            <figcaption>
              The miss across {stats.n} metros, in percentage points. Left of zero the metro grew less than the model
              expected.
            </figcaption>
          </figure>

          <div className="acc-scroll">
            <table className="acc-table">
              <caption>The same distribution as numbers, in percentage points</caption>
              <thead>
                <tr>
                  <th scope="col">figure</th>
                  <th scope="col" className="v">value</th>
                  <th scope="col">what it says</th>
                </tr>
              </thead>
              <tbody>
                <tr><th scope="row">median</th><td className="v">{pp(stats.median)}</td><td>the middle metro, which outliers cannot move</td></tr>
                <tr><th scope="row">mean</th><td className="v">{pp(stats.mean)}</td><td>the average miss, the lean in one number</td></tr>
                <tr><th scope="row">middle half</th><td className="v">{pp(stats.q1)} to {pp(stats.q3)}</td><td>where half the metros landed</td></tr>
                <tr><th scope="row">middle 90 percent</th><td className="v">{pp(stats.p05)} to {pp(stats.p95)}</td><td>{tail.toFixed(1)} points wide, the spread worth planning around</td></tr>
                <tr><th scope="row">standard deviation</th><td className="v">{pp(stats.sd, false)}</td><td>the spread, if the shape were normal, which the tails say it is not</td></tr>
                <tr><th scope="row">mean absolute error</th><td className="v">{pp(stats.mae, false)}</td><td>the typical size of a miss, either way</td></tr>
                <tr><th scope="row">root mean squared error</th><td className="v">{pp(stats.rmse, false)}</td><td>the same, with big misses weighted more</td></tr>
                <tr><th scope="row">worst either way</th><td className="v">{pp(stats.min)} to {pp(stats.max)}</td><td>the top rows of the next section</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="acc-block">
          <h3>2. Where it was most wrong</h3>
          <p>Both directions, biggest gap first. Pick a metro to open it on the map.</p>
          <div className="acc-pair">
            <MissTable
              rows={worst.above}
              caption={`The ${worst.above.length} metros that beat the model by the most`}
              empty="Not one metro grew more than the model expected."
              go={go}
            />
            <MissTable
              rows={worst.below}
              caption={`The ${worst.below.length} metros the model most overshot`}
              empty="Not one metro grew less than the model expected."
              go={go}
            />
          </div>
          <p className="acc-foot">
            Growth is the percent change in the FHFA index over the four quarters from the origin
            {asOf && until ? `, ${asOf} to ${until}` : ""}. The miss is in percentage points.
          </p>
        </section>

        <section className="acc-block">
          <h3>3. What goes with a bigger miss</h3>
          <p>
            FHFA publishes a standard error for each metro's index, as a percent of the index. The guess is that
            a loosely measured metro is also harder to forecast.
          </p>
          {fit === null || bins.length === 0 ? (
            <p className="acc-empty">This build carries no index standard errors, so there is nothing to test the miss against.</p>
          ) : (
            <>
              <p>
                {holds} Across the {fit.n} metros carrying both, the correlation between the index error and the size
                of the miss is {fit.r.toFixed(2)}, so the line accounts for about {share(fit.r2)} of the spread. The line
                is a summary of the cloud. It does not say a loose index causes a bad forecast.
              </p>
              <p>
                In four equal groups by index error, the typical miss runs{" "}
                {bins.map((bin) => bin.meanAbs.toFixed(1)).join(", ")} points
                {steady ? ", rising at every step" : ", not rising at every step"}. The rank correlation is{" "}
                {fit.rho === null ? "not defined here" : fit.rho.toFixed(2)}
                {fit.rho !== null && fit.rho < fit.r ? ", lower than the straight one, so one end of the range carries the line" : ""}.
              </p>
              {size4 !== null && (
                <p>
                  The index error also tracks size, with a correlation of {size4.r.toFixed(2)} against log population
                  across {size4.n} metros, so this partly restates that small metros are harder to forecast.
                </p>
              )}

              <figure className="acc-figure">
                <svg
                  ref={cloudSvg}
                  className="acc-chart acc-cloud"
                  width={size.width}
                  height={size.height}
                  viewBox={`0 0 ${size.width} ${size.height}`}
                  role="img"
                  aria-label={scatterTitle(cloud)}
                  tabIndex={0}
                  onMouseMove={(e) => {
                    const at = inside(cloudSvg.current, e);
                    setDot(at === null ? null : nearestMetro(cloud, at.x, at.y));
                  }}
                  onMouseLeave={() => setDot(null)}
                  onKeyDown={stepDot}
                  onBlur={() => setDot(null)}
                >
                  <title>{scatterTitle(cloud)}</title>
                  {cloud.yTicks.map((t) => (
                    <g key={t.value}>
                      <line className="grid" x1={cloud.left} x2={cloud.right} y1={t.y} y2={t.y} />
                      <text className="lbl" x={cloud.left - 6} y={t.y + 3} textAnchor="end">{t.value}</text>
                    </g>
                  ))}
                  {cloud.points.map((p) => (
                    <circle key={p.cbsa} className={`dot${dot !== null && dot.cbsa === p.cbsa ? " on" : ""}`} cx={p.x} cy={p.y} r={2.6} />
                  ))}
                  <path className="fit" d={cloud.fitD} />
                  {bins.map((mark) => (
                    <g key={mark.from} className="binmark">
                      <rect x={mark.x - 4.5} y={mark.y - 4.5} width={9} height={9} />
                      <line x1={mark.x - 9} x2={mark.x + 9} y1={mark.y} y2={mark.y} />
                    </g>
                  ))}
                  {cloud.xTicks.map((t) => (
                    <text key={t.value} className="lbl" x={t.x} y={cloud.bottom + 14} textAnchor="middle">{t.value}</text>
                  ))}
                  <text className="side" x={cloud.right} y={size.height - 6} textAnchor="end">index standard error, percent of the index</text>
                  <text className="side" x={cloud.left - 26} y={cloud.top - 12} textAnchor="start">miss, points</text>
                </svg>
                <p className="acc-readout" aria-live="polite">
                  {dot === null ? (
                    <span className="hint">point at the cloud or use the arrow keys to name a metro</span>
                  ) : (
                    <span>
                      <button type="button" className="acc-link" onClick={() => go(openMetro(dot.cbsa))}>{dot.name}</button>
                      {" "}missed by {dot.miss.toFixed(1)} points with an index error of {dot.error.toFixed(2)}
                    </span>
                  )}
                </p>
                <figcaption>
                  One dot per metro: how loosely its index is measured against how far the call missed. The dashed
                  line is the fit, the squares the average miss in each quarter of metros.
                </figcaption>
              </figure>

              <div className="acc-scroll">
                <table className="acc-table">
                  <caption>Metros in four equal groups, loosest measured index last</caption>
                  <thead>
                    <tr>
                      <th scope="col">index error</th>
                      <th scope="col" className="v">metros</th>
                      <th scope="col" className="v">typical miss</th>
                      <th scope="col" className="v">average miss</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bins.map((bin) => (
                      <tr key={bin.from}>
                        <th scope="row">{bin.from.toFixed(2)} to {bin.to.toFixed(2)}</th>
                        <td className="v">{bin.n}</td>
                        <td className="v">{pp(bin.meanAbs, false)}</td>
                        <td className={`v ${bin.meanSigned < 0 ? "over" : "under"}`}>{pp(bin.meanSigned)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="acc-foot">Typical miss ignores direction, average miss keeps it.</p>
            </>
          )}
        </section>

        {spread !== null && (
          <section className="acc-block">
            <h3>4. Why {stats.n} metros are worth less than {stats.n} tests</h3>
            <p>
              As independent draws, the lean above has a standard error of {stats.se.toFixed(2)} points. They are not
              independent: metros share one national housing cycle, and when the country slows almost every metro
              undershoots at once. {spread.agreeing} of the {spread.groups.length} states with at least {MIN_STATE}{" "}
              scored metros missed the same way, and letting metros in a state move together{" "}
              {clusterMoves === "leaves" ? "leaves the standard error at" : `${clusterMoves} the standard error to`}{" "}
              {spread.clusterSe.toFixed(2)}. {leaning ? "The lean survives that." : "The lean does not survive that."}
              {" "}This is one origin quarter. One draw of the cycle cannot separate a model that always runs{" "}
              {ran} from one that ran {ran} in a year the market turned.
            </p>
            {spread.groups.length > 0 && (
              <div className="acc-scroll">
                <table className="acc-table acc-states">
                  <caption>Average miss by state, states with at least {MIN_STATE} scored metros</caption>
                  <thead>
                    <tr>
                      <th scope="col">state</th>
                      <th scope="col" className="v">metros</th>
                      <th scope="col" className="v">average miss</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spread.groups.map((group) => (
                      <tr key={group.state}>
                        <th scope="row">{group.state}</th>
                        <td className="v">{group.n}</td>
                        <td className={`v ${group.mean < 0 ? "over" : "under"}`}>{pp(group.mean)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {now !== null && (
          <section className="acc-block">
            <h3>5. What it says now</h3>
            <p>
              The live call is {pct(now.median)} for the median metro over the next four quarters, with the middle half
              between {pct(now.q1)} and {pct(now.q3)}
              {now.median8 === null ? "" : `, and ${pct(now.median8)} over eight quarters`}. The two are different
              fits: the backtest's model and the refit. If the refit missed like the backtest, {pct(now.median)} would
              land nearer {pct(repeat)}, but that is not a correction anyone should apply.
            </p>
            {now.bandWidth !== null && now.bandMin !== null && now.bandMax !== null && (
              <p>
                The model publishes a 90 percent interval a median {now.bandWidth.toFixed(1)} points wide,{" "}
                {now.bandMin.toFixed(1)} to {now.bandMax.toFixed(1)} across all {now.bandN} metros.
                {/* whether one year's misses make the band look too wide is read off the two widths */}
                {tail < now.bandWidth
                  ? ` Last year's misses spanned only ${tail.toFixed(1)} points in their middle 90 percent. The band has to cover where prices land, and one year is one draw of the cycle.`
                  : ` Last year's misses spanned ${tail.toFixed(1)} points in their middle 90 percent, as wide as the band or wider.`}
                {cover4 !== null
                  ? ` On the whole test block from 2022 on, the backtest's own band, calibrated on 2018 to 2021, held ${Math.round(cover4 * 100)} percent of outcomes at four quarters ${cover4 < NOMINAL_COVERAGE ? "against" : "and reached"} the ${Math.round(NOMINAL_COVERAGE * 100)} it aims for.`
                  : ""}
                {" "}{flatBand
                  ? "The bigger problem is that the band is nearly one national width, so it says little about which metros are hardest to pin down."
                  : "Its width varies enough between metros to say which ones the model is least sure of."}
              </p>
            )}
            <p className="acc-foot">
              This page scores one horizon, four quarters, at one origin. The comparison against simple baselines is
              on the Model page.
            </p>
          </section>
        )}

        <p className="acc-foot">
          Source: Loop model{asOf ? `, origin ${asOf}` : ""}, scored against the FHFA House Price Index.
          {" "}{stats.n} of {seen.metros} metros carry a scored call
          {seen.unscored > 0 ? `${seen.unscored === 1 ? ". The other one is" : `. The other ${seen.unscored} are`} not counted anywhere on this page` : ""}.
          {seen.withError < stats.n ? ` ${stats.n - seen.withError} of the scored metros carry no index standard error and sit out of section 3.` : ""}
          {seen.divisions > 0
            ? seen.overlap > 0
              ? ` ${seen.overlap} of the scored areas are metropolitan divisions whose parent metro is scored too, so a few big places are counted twice, once whole and once in parts.`
              : ` ${seen.divisions} of the scored areas are metropolitan divisions, the pieces of ${seen.parents} larger ${seen.parents === 1 ? "metro" : "metros"} scored in parts rather than whole, so no place is counted twice.`
            : ""}
          {" "}The index standard error is FHFA's own figure.
        </p>
      </div>
    </div>
  );
}

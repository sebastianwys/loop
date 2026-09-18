import { useMemo } from "react";
import { formatValue } from "../lib/format";
import {
  LONG_RUN, NOMINAL_COVERAGE, NO_CHANGE, SHIPPED, asPercent, bandCut, bandExtremes, bestAt, closestTo,
  coverageRange, errorCut, horizonsIn, leaderboard, lossSentence, lossesOf, modelLabel, points, rowAt,
  sentenceCase, spreadOf,
} from "../lib/model";
import { BACKTEST } from "../lib/modelNumbers";
import type { ViewProps } from "../lib/views";
import { ModelFigure } from "./ModelFigure";
import "../styles/model.css";

const rate = (value: number | null | undefined) =>
  formatValue(typeof value === "number" ? value : null, "rate", true);

// the walkthrough in ml/README.md as a page: the panel, the evaluation
// design, the models, the results, the shipped forecast, the limits.
//
// every number here is read rather than written down. the leaderboard comes
// from ml/results/backtest through scripts/model-assets.mjs, and the shipped
// forecast is measured off the same json the map draws, so a retrain or a
// fresh export moves this page with it instead of leaving it lying
export function ModelPage({ data }: ViewProps) {
  const rows = BACKTEST;
  const horizons = useMemo(() => horizonsIn(rows), [rows]);
  const board = useMemo(() => leaderboard(rows), [rows]);
  const winners = useMemo(
    () => new Map(horizons.map((horizon) => [horizon, bestAt(rows, horizon)?.model ?? null])),
    [rows, horizons],
  );

  const shipped8 = rowAt(rows, SHIPPED, 8);
  const longRun8 = rowAt(rows, LONG_RUN, 8);
  const longRun4 = rowAt(rows, LONG_RUN, 4);
  const shipped4 = rowAt(rows, SHIPPED, 4);
  const losses = useMemo(() => lossesOf(rows, SHIPPED), [rows]);
  const closest8 = closestTo(rows, SHIPPED, 8);
  const eighth = coverageRange(rows, 8);
  const scored = rows.length > 0 ? rows[0].n : null;

  const cut4 = asPercent(errorCut(rows, SHIPPED, NO_CHANGE, 4));
  const cut8 = asPercent(errorCut(rows, SHIPPED, NO_CHANGE, 8));
  const band4 = asPercent(bandCut(rows, SHIPPED, LONG_RUN, 4));
  const band8 = asPercent(bandCut(rows, SHIPPED, LONG_RUN, 8));

  const near = useMemo(() => spreadOf(data.metros, "hpi_forecast_4q"), [data.metros]);
  const far = useMemo(() => spreadOf(data.metros, "hpi_forecast_8q"), [data.metros]);
  const spans = useMemo(() => bandExtremes(data.metros, "hpi_forecast_4q"), [data.metros]);
  const error = useMemo(() => spreadOf(data.metros, "hpi_index_error"), [data.metros]);
  const origin = near?.origin ?? far?.origin ?? null;

  const lossText = lossSentence(losses);

  return (
    <main className="model-page">
      <div className="model-inner">
        <header className="model-head">
          <h2>How the forecast is built and judged</h2>
          <p className="model-lead">
            The Forecasts metrics on the map come from a model fitted in this repository. It reads a
            metro's quarterly history and answers one question: given what is known at this quarter,
            how much does the house price index move over the next one, two, four and eight quarters,
            and how sure can it be. This page is the case for believing those numbers, including the
            places where the model loses.
          </p>
          <ul className="model-stats">
            <li>
              <span className="value">{cut4 ? `${cut4}%` : "-"}</span>
              <span className="label">less error at four quarters</span>
              <span className="note">against the rule that says nothing changes</span>
            </li>
            <li>
              <span className="value">{band4 ? `${band4}%` : "-"}</span>
              <span className="label">narrower band at four quarters</span>
              <span className="note">against the metro's own fifty year average</span>
            </li>
            <li>
              <span className="value">{points(shipped8?.coverage)}</span>
              <span className="label">band coverage at eight quarters</span>
              <span className="note">against a nominal {points(NOMINAL_COVERAGE)}, and that is a miss</span>
            </li>
          </ul>
        </header>

        <section className="model-section">
          <h3>The panel</h3>
          <p>
            One row per metro per quarter: 410 metros, 1975Q1 to 2026Q2, 71,072 rows. The FHFA
            all-transactions index is the thing being forecast. Fourteen features feed the models and
            eight more columns ride along for the figures without reaching one.
          </p>
          <p>
            Nothing leaks. A monthly value is known in the month it covers. An annual value for year
            Y is known only from the first quarter of Y plus one. A metropolitan division inherits
            what it lacks from its parent metro. The build writes a manifest with row counts, the
            non-null share of every column and the hash of the panel it produced.
          </p>
          <ModelFigure id="coverage" />
          <p>
            How late a series starts matters more than it looks. A feature can only be learned where
            the model is fitted, and the fitting block ends in 2017, so the share of fitting samples
            it reaches is what decides whether it can be learned at all. Listings and inventory are
            present in every test sample and in none of the fitting ones: the model was being scored
            on information it had never once been taught to use. Zillow home values reach 0.40 of the
            fitting block, population and migration 0.14, income 0.03.
          </p>
          <p>
            Two of those sources could be deepened and were. Unemployment went from 0.09 of the
            fitting block to 0.79 and the mortgage rate from 0.50 to 1.00, and that alone cut
            validation loss from 0.006602 to 0.006564.
          </p>
        </section>

        <section className="model-section">
          <h3>The evaluation design</h3>
          <p>
            This is the part that makes the numbers mean anything. The target is log growth of the
            index over h quarters. A sample is one metro, one origin quarter, one horizon, and it
            lands in a block by where its outcome falls, never by where it starts.
          </p>
          <div className="model-scroll">
            <table className="model-table blocks">
              <caption>The three blocks, and what each one is allowed to touch.</caption>
              <thead>
                <tr>
                  <th scope="col">block</th>
                  <th scope="col">outcome realized</th>
                  <th scope="col">used for</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">train</th>
                  <td>by 2017Q4</td>
                  <td>fitting</td>
                </tr>
                <tr>
                  <th scope="row">calibration</th>
                  <td>2018 to 2021</td>
                  <td>band width only</td>
                </tr>
                <tr>
                  <th scope="row">test</th>
                  <td>2022Q1 or later</td>
                  <td>scored once</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Because the outcome quarter decides the block, one origin sits in different blocks at
            different horizons. Nothing realized after 2021 reaches a model judged on 2022 onward.
          </p>
          <ModelFigure id="design" />
          <p>
            An earlier version of this rule read the block off the origin instead. That left 3,280
            calibration samples at eight quarters where the rule gives 6,560, and all of them landed
            in the 2020 to 2021 boom, so every published band width came off two years of the least
            representative data in the panel. The blocks are horizon independent now: 6,560
            calibration samples and {scored ? scored.toLocaleString("en-US") : "about 7,375"} test
            samples at every horizon.
          </p>
          <p>
            The bands are conformalized quantile regression. The model predicts the 10th, 50th and
            90th percentiles, and the calibration block sets the smallest widening of that band that
            covers at least 90 percent of held-out outcomes, with the finite sample correction of
            Romano, Patterson and Candes (2019). That guarantee assumes exchangeable samples, and
            quarters are not exchangeable. So the coverage measured on the test block is the honest
            number, and it is printed beside every model below.
          </p>
        </section>

        <section className="model-section">
          <h3>The models</h3>
          <p>
            Five classical rules set the bar: no change, momentum, the metro's own average growth,
            ridge on price lags and covariates, and gradient boosting with quantile losses. Two
            networks share one input: 24 quarters of ten series each with a presence mask, four
            annual features at the origin, and a learned embedding per metro. The window MLP flattens
            that into a three layer perceptron. The sequence GRU reads it as a sequence and
            concatenates the final state with the annual features and the embedding. Both emit three
            monotone quantiles per horizon and train on pinball loss with Adam, weight decay and
            early stopping.
          </p>
          <p>
            Learning rate, weight decay and the input set are chosen on validation loss alone, never
            on test. The validation set is the tail of the fitting block, outcomes realized 2015 to
            2017.
          </p>
          <ModelFigure id="training" />
          <p>
            Two of the ten series are new, and both come from a file FHFA publishes beside the index
            that this project had downloaded and never read: the expanded-data index, a second
            estimate of the same metro quarter built from more records, and the standard error FHFA
            reports for it. That error is the only published measure of how thin a metro's
            repeat-sale record is
            {error
              ? `, and it is the difference between ${error.lowest.name} measured to within ${points(error.lowest.value)} percent and ${error.highest.name} measured to within ${points(error.highest.value, 1)} percent`
              : ""}
            . The model has no other way to know that.
          </p>
          <p>
            Input sets were compared on validation loss and nothing else. The shipped ten series come
            in at 0.006202. Dropping the expanded index costs a lot, 0.006564. Carrying both forms of
            the index error buys 0.000003, which is noise, so the simpler set stays. Adding CPI, the
            ten year, the term spread and national unemployment is worse than not having them at
            0.006618: one number shared by all 410 metros tells a window which era it sits in and
            nothing about the place. The rejected columns stay in the panel, out of reach of every
            model, because a negative result that is one command from being re-run is worth more than
            one written down.
          </p>
        </section>

        <section className="model-section">
          <h3>The results, 2022Q1 onward</h3>
          <div className="model-scroll">
            <table className="model-table board">
              <caption>
                The test block, scored once.
                {scored ? ` Every model sees the same ${scored.toLocaleString("en-US")} samples at each horizon.` : ""}
                {" "}The first number is the mean absolute error of the median forecast, in percentage
                points of growth, so lower is better. Under it: the share of outcomes that fell inside
                the 90 percent band, and that band's mean width in log growth units.
              </caption>
              <thead>
                <tr>
                  <th scope="col">model</th>
                  {horizons.map((horizon) => (
                    <th key={horizon} scope="col" className="v">{horizon} {horizon === 1 ? "quarter" : "quarters"}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {board.map((row) => (
                  <tr key={row.model}>
                    <th scope="row">
                      {row.label}
                      {row.shipped && <span className="tag">on the map</span>}
                    </th>
                    {row.cells.map((cell, i) => (
                      <td key={horizons[i]} className="v">
                        {cell === null ? "-" : (
                          <>
                            <span className={winners.get(horizons[i]) === row.model ? "mae best" : "mae"}>
                              {points(cell.maePct)}
                              {winners.get(horizons[i]) === row.model && <span className="sr"> lowest error at this horizon</span>}
                            </span>
                            <span className="sub">
                              cover {points(cell.coverage)}, width {points(cell.width, 3)}
                            </span>
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ModelFigure id="comparison" />
          <p>
            Every model on that table improved when the two FHFA columns joined, because every model
            gets the same inputs. That is the point of a shared evaluation frame: a new feature has to
            beat the classical rules holding the same feature, not the version of them that never saw
            it.
          </p>
          <h4>Three honest readings</h4>
          <ul className="model-readings">
            <li>
              The sequence GRU wins where the horizon is long. It cuts the no-change error{" "}
              {cut4 ?? "-"} percent at four quarters and {cut8 ?? "-"} percent at eight, and it beats
              the metro's own fifty year average at every horizon, which is the rule that matters: a
              long mean is a good guess at a trend and a bad one across a boom. That average degrades
              from {points(longRun4?.maePct)} to {points(longRun8?.maePct)} points as the horizon
              doubles while the GRU goes {points(shipped4?.maePct)} to {points(shipped8?.maePct)}.
            </li>
            <li>
              {lossText
                ? `It loses the short ones, where ${lossText}. A penalised linear model on the same features is hard to beat one quarter out, and that is worth saying out loud.`
                : "In this build it is ahead at every horizon, which is not the usual result and is worth re-reading rather than celebrating."}
            </li>
            <li>
              {closest8
                ? `At eight quarters the nearest rival is ${modelLabel(closest8.model)}, ${points(closest8.gap)} points away. Two years out, that is not a gap anyone should bet on. The GRU's case at that horizon rests on its band being ${band8 ?? "-"} percent narrower than the long run average's, not on those ${points(closest8.gap)} points.`
                : "At eight quarters the field is too thin in this build to name a rival."}
            </li>
          </ul>
          <ModelFigure id="calibration" />
        </section>

        <section className="model-section">
          <h3>The shipped forecast</h3>
          <p>
            What the map draws is the GRU refitted on every outcome realized by {origin ?? "the last quarter of the panel"},
            at the epoch count found on validation. Its band margin is out of sample: a second GRU
            fitted through 2021, calibrated on 2022 onward, and that margin applied to the final
            quantiles.
          </p>
          {near && (
            <p>
              {`At the ${near.origin ?? "current"} origin the median four quarter forecast across `}
              {`${near.count} metros is ${rate(near.median)}, with the 10th to 90th percentile `}
              {`running ${rate(near.p10)} to ${rate(near.p90)}. `}
              {/* whether anywhere is forecast to fall is a fact about this export, not a slogan */}
              {near.falling === 0
                ? `It is positive everywhere: the weakest metro is ${near.lowest.name} at ${rate(near.lowest.value)}, the strongest ${near.highest.name} at ${rate(near.highest.value)}.`
                : `${near.falling === 1 ? "One of them is" : `${near.falling} of them are`} forecast to fall, the weakest ${near.lowest.name} at ${rate(near.lowest.value)}, against ${near.highest.name} at ${rate(near.highest.value)}.`}
              {far ? ` The eight quarter median is ${rate(far.median)}.` : ""}
            </p>
          )}
          <ModelFigure id="fans" />
          {spans && (
            <p>
              Every band is wide, and that is the point of publishing one. The narrowest four quarter
              band on the map belongs to {spans.narrow.name} and still runs {rate(spans.narrow.lo)} to{" "}
              {rate(spans.narrow.hi)}. The widest belongs to {spans.wide.name}, {rate(spans.wide.lo)}{" "}
              to {rate(spans.wide.hi)}. A forecast of {rate(spans.wide.point)} inside a band that
              wide is a direction, not a number to plan against.
            </p>
          )}
          <ModelFigure id="distribution" />
          <p>
            One number in the map's Forecasts group is not a forecast at all. The index standard
            error is FHFA's own measurement, credited to FHFA, and it rides in the model's export
            because nothing else on the map carries it. It belongs beside a forecast because it says how firmly the thing
            being forecast is even measured
            {error
              ? `: ${points(error.lowest.value)} percent in ${error.lowest.name}, a deep and liquid market, against ${points(error.highest.value, 1)} percent in ${error.highest.name}, which is small and thinly traded`
              : ""}
            . A wide error there is a reason to read the forecast above it loosely.
          </p>
        </section>

        <section className="model-section model-limits">
          <h3>The limits</h3>
          <p>
            This is not the footnote. It is the part a reader deciding whether to trust the map should
            read first.
          </p>
          <ul>
            <li>
              <strong>The bands fail at eight quarters.</strong> The shipped model covers{" "}
              {points(shipped8?.coverage)} of outcomes there against a nominal{" "}
              {points(NOMINAL_COVERAGE)}
              {eighth ? `, and no model on the table escapes it: the field runs ${points(eighth.low.coverage)} for ${modelLabel(eighth.low.model)} to ${points(eighth.high.coverage)} for ${modelLabel(eighth.high.model)}` : ""}
              . The cause is a calibration block fixed at 2018 to 2021 by choice. Conformal coverage
              is guaranteed only for exchangeable samples: calibration outcomes land in the run up and
              the boom, test outcomes land in the correction, and no margin fitted on the first covers
              the second. Rolling the calibration window forward would fix the number by calibrating
              on the period being scored, which is leakage, so it is reported rather than repaired. A
              wider held out period, or a conformal method built for distribution shift, is the real
              answer.
            </li>
            <li>
              <strong>It loses the short horizons.</strong>{" "}
              {lossText
                ? `${sentenceCase(lossText)}. If the question is one quarter out, the penalised linear model is the better answer, and the network earns its place only as the horizon lengthens.`
                : "Not in this build, which is worth checking rather than celebrating."}
            </li>
            <li>
              <strong>The long horizon win is thin.</strong>{" "}
              {closest8
                ? `The nearest rival, ${modelLabel(closest8.model)}, is ${points(closest8.gap)} points behind at eight quarters, ${points(rowAt(rows, closest8.model, 8)?.maePct)} against ${points(shipped8?.maePct)}. A gap that size over two years is inside the noise, and anyone reading this table as a ranking of ideas rather than of runs is reading too much into it.`
                : ""}
            </li>
            <li>
              <strong>Some features are thin exactly where they are taught.</strong> Rents reach 2015
              and Zillow values 2000, so both are sparse in the fitting block. Listings and inventory
              exist only as annual means, and keeping their monthly history would sharpen what the
              model is handed at forecast time without teaching it anything: those series are 0.00 of
              the fitting block at any sampling rate. The fix is a later fitting era, not a better
              collector, and a later fitting era buys fewer years to learn from. That trade has not
              been made here.
            </li>
            <li>
              <strong>The index error is fitted in the wrong units.</strong> It enters the model as
              index points, and FHFA rebases every metro to 100 at its own start, so the same number
              means different things in two metros. Expressed as a percent of the index it is scale
              free and slightly worse on validation, 0.006225 against 0.006202. The metro embedding is
              the likely reason the raw form survives. The percent form is what ships to the map,
              where a reader is comparing metros and the model is not.
            </li>
          </ul>
        </section>

        <p className="model-foot">
          The leaderboard on this page is generated from the backtest files under ml/results at build
          time, and the forecast figures are measured off the same data file the map draws, so a
          retrain or a fresh export moves this page with it. The full walkthrough, with the input
          hashes and the commands that reproduce every figure, is ml/README.md in the repository.
        </p>
      </div>
    </main>
  );
}

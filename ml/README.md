# ml

Forecasting on top of the pipeline in the repo root. Given what is known about a metro at a quarter, how much does its house price index move over the next one, two, four and eight quarters, and how sure can the model be.

Headline: a sequence GRU wins both long horizons outright, cuts the no-change error 45 percent at four quarters and 44 at eight on mean absolute error in percentage points, and runs bands 29 percent narrower at four quarters and 36 at eight than the metro's own long run average.

## The Input

| item | value |
|---|---|
| file | `../data/integrated/hpi_census_merged.csv` |
| rows x cols | 1,197 x 24 |
| metros | 410, of which 37 are metropolitan divisions |
| years | 2014, 2019, 2024 |
| sha256 | `ce2322ba9a7a6c938db3b2616baadf95ecdbd528d64ed0598d5e4d93394e9d4b` |

Read only. This folder never writes to `data/`. If the pipeline re-runs, the hash in the loader is updated in the same commit.

## The Setup

```bash
cd ml
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -e .
.venv/bin/python run_tests.py
```

Run the whole chain from the repo root:

```bash
ml/.venv/bin/python -m loop.panel
ml/.venv/bin/python -m loop.baselines
ml/.venv/bin/python -m loop.train
ml/.venv/bin/python -m loop.export
ml/.venv/bin/python -m bot.build_map_data
```

About four minutes on an M4. Every step leaves a figure in `results/figures/`.

## The Panel

One row per metro per quarter. 410 metros, 1975Q1 to 2026Q2, 71,072 rows. FHFA all-transactions gives the target. Nothing leaks: a monthly value is known in its month, an annual value for year Y only from the first quarter of Y+1, and divisions inherit what they lack from the parent metro. `results/panel_manifest.json` records row counts, the non-null share of every column and the parquet hash.

![where the panel has data](results/figures/01_coverage.png)

The rule in that figure is `spec.FIT_END`, and it is the only date that matters: the train block runs to 2017Q4 but its last three years are held out for validation, so a model fits on outcomes through 2014Q4. A column with no value left of the rule fails the `seen` test in `nets.moments`, and `encode` then zeroes both its value and its presence channel in every window, the test block included.

Fourteen columns are declared as features. Nine survive that test. Eight further columns ride along for the figures and the map without reaching a model, and why is in The Models.

| feature | share of fitting samples | share of test samples |
|---|---|---|
| price growth, mortgage rate | 1.00 | 1.00 |
| unemployment | 0.82 | 1.00 |
| expanded index and its error | 0.76 / 0.79 | 1.00 |
| Zillow home values | 0.38 | 0.98 |
| population and migration | 0.09 | 0.99 |
| permits, income, rents, listing prices, inventory | 0.00 | 0.87 to 1.00 |

The last row is the one to read. Those five reach 87 to 100 percent of test samples and none of the fitting ones, so every published number below is a nine-feature model's. Deepening the two sources that could be deepened moved unemployment from 0.09 to 0.82 and the mortgage rate from 0.50 to 1.00; the other five cannot be deepened, because the data does not exist earlier. `admit.py` measures them at a boundary where they are visible, and the result is in The Models.

![feature trends](results/figures/03_feature_trends.png)
![house prices since 1990](results/figures/02_hpi_history.png)
![latest snapshot](results/figures/04_latest_snapshot.png)

## The Evaluation Design

This is the part that makes the numbers mean anything.

The target is log growth of the index over h quarters. A sample is one metro, one origin quarter, one horizon. It lands in a block by where its outcome falls:

| block | outcome realized | used for |
|---|---|---|
| train | by 2017Q4 | fitting |
| calibration | 2018 to 2021 | band width only |
| test | 2022Q1 or later | scored once |

The outcome quarter decides the block and nothing else does, so one origin sits in
different blocks at different horizons. Nothing realized after 2021 reaches a model
judged on 2022 onward.

An earlier version of `spec.block` read calibration and test off the origin instead.
That left 3,280 calibration samples at eight quarters where the rule gives 6,560, and
all of them landed in the 2020 to 2021 boom, so every published band width came off
two years of the least representative data in the panel. It also discarded every
sample whose outcome crossed a block edge. The blocks are horizon independent now,
6,560 calibration and about 7,375 test samples at each horizon.

![how the backtest is split](results/figures/05_backtest_design.png)

Bands come from conformalized quantile regression. The model predicts the 10th, 50th and 90th percentiles. The calibration block sets the smallest widening of that band covering at least 90 percent of held-out outcomes, with the finite sample correction of Romano, Patterson and Candes (2019).

That guarantee assumes exchangeable samples. Quarters are not exchangeable. So the test block coverage is the honest number, and it is reported beside every model.

## The Models

Five classical rules set the bar: no change, momentum, the metro's own average growth, ridge on price lags and covariates, and gradient boosting with quantile losses.

![baseline errors](results/figures/06_baseline_errors.png)
![calibration of the baselines](results/figures/07_calibration.png)
![actual against predicted](results/figures/08_actual_vs_predicted.png)

Two networks share one input: 24 quarters of seven series with a presence mask each, four annual features at the origin, and a learned embedding per metro. The window MLP flattens it into a three layer perceptron. The sequence GRU reads it as a sequence, then concatenates the final state with the annual features and the embedding. Both emit three monotone quantiles per horizon and train on pinball loss with Adam, weight decay and early stopping.

Learning rate, weight decay and the input set are chosen on validation loss alone, never on test. The validation set is the tail of the fitting block, outcomes realized 2015 to 2017.

Two of those seven series are new, and both come from a file FHFA publishes beside the index and this project had downloaded and never read. `hpi_exp_metro.txt` carries the expanded-data index, a second FHFA estimate of the same metro quarter built from more records, and `rstderr`, the standard error FHFA reports for it. The error is the only published measure of how thin a metro's repeat-sale record is, and the model has no other way to know that Hinesville is measured to within 3.7 percent while Denver is measured to within 0.05.

Candidate inputs, each fitted the same way and read on validation loss:

| input set | validation loss |
|---|---|
| seven series, the shipped set | 0.006204 |
| plus both forms of the index error | 0.006197 |
| expanded index, no error | 0.006209 |
| the error as a percent of the index instead of index points | 0.006229 |
| five series, no expanded index | 0.006567 |
| plus the metro against the cross section median | 0.006561 |
| plus the calendar quarter as a sine and cosine | 0.006566 |
| plus CPI, the ten year, the term spread and national unemployment | 0.006617 |

The expanded index carries most of the gain and the error adds the rest. Two rows land on the wrong side of nothing: carrying both forms of the error buys 0.000007, and the metro against the cross section median buys 0.000006. Both sit inside the seed spread, which `admit.py` measures at 0.000036 to 0.000051 over five seeds, and every row of this table is one seed. A margin that thin is a coin, so the simpler set stays. The four national series are worse than not having them by enough to read: one number shared by all 410 metros tells a window which era it sits in and nothing about the place, which is the same answer an earlier experiment on the metro running mean and the national mean gave. The rejected columns stay in the panel as `spec.CONTEXT`, out of reach of every model, because a negative result that is one command from being re-run is worth more than one written down.

`ablate.py` reproduces the table. It reads the validation block and nothing else.

That gate has a blind spot, and five columns fell into it. `nets.feature_stats` takes its `seen` mask from the fitting block and `nets.to_tensors` encodes every window with that mask, so a feature the fitting block never observes is zeroed in the validation block too, in both arms of any comparison. Rents, listing prices, inventory, permits and income were all in that state: declared as features, present in 87 to 100 percent of test samples, and reaching the network in none of them. They were never rejected here, they were never measured.

`admit.py` measures them by moving the boundary instead. It fits through 2019Q4, where four of the five are visible, and scores on the 13,120 outcomes realized in 2020 and 2021. The test block is never read, and a guard reads the label grid the model is handed and refuses the run if it ever is. Five seeds per arm, epochs re-picked inside each arm:

| input set | series | validation loss | recovers |
|---|---|---|---|
| nine, what the old gate could see | 9 | 0.012601 | none |
| plus rents and listing prices | 11 | 0.012570 | a thirtieth |
| plus permits and income | 11 | 0.012465 | all of it |
| all four | 13 | 0.012465 | all of it |

Permits and income carry the whole gain. Rents and listing prices recover 31 parts in a million against a seed spread of 36 to 51, which is nothing, and adding them on top of permits and income changes the loss in the sixth decimal. So the shipped set is eleven series, and rents, listing prices and inventory join `spec.CONTEXT`. Inventory is the one case nothing can settle: it starts 2020Q1, so any fitting window that sees it consumes the block that would score it, and it is dropped as unmeasurable rather than kept unmeasured.

Two cautions belong with that table. The scored block is the 2020 to 2021 boom, because it is the only window between the old fitting block and the test block. And permits and income enter the panel as annual means, which figure 03 shows as step functions.

![training curves](results/figures/09_training_curves.png)
![quantile calibration](results/figures/10_quantile_calibration.png)

## The Results, 2022Q1 to 2026Q2

Mean absolute error of the median forecast, in percentage points of growth. Coverage is the share of outcomes inside the 90 percent band.

| model | 1q | 2q | 4q | 8q | coverage 1q/2q/4q/8q |
|---|---|---|---|---|---|
| no change | 2.30 | 3.72 | 7.66 | 18.05 | 0.87 / 0.91 / 0.86 / 0.68 |
| momentum | 2.10 | 2.94 | 5.89 | 15.56 | 0.76 / 0.84 / 0.81 / 0.54 |
| metro mean | 2.02 | 2.90 | 5.13 | 11.82 | 0.88 / 0.92 / 0.87 / 0.69 |
| ridge | 1.81 | 2.49 | 4.36 | 10.41 | 0.77 / 0.88 / 0.86 / 0.64 |
| gradient boosting | 1.85 | 2.72 | 4.42 | 10.75 | 0.76 / 0.82 / 0.91 / 0.72 |
| window mlp | 2.17 | 3.24 | 6.58 | 15.62 | 0.82 / 0.92 / 0.92 / 0.68 |
| sequence gru | 1.93 | 2.57 | 4.21 | 10.16 | 0.80 / 0.88 / 0.87 / 0.66 |

Every model on this table improved when the two FHFA columns joined, because every model gets the same inputs. That is the point of a shared evaluation frame: a new feature has to beat the classical rules holding the same feature, not the version of them that never saw it.

![model comparison](results/figures/12_model_comparison.png)

Three honest readings of that table.

- The GRU wins where the horizon is long, by 0.15 points over ridge at four quarters and 0.25 at eight, and ridge wins the short ones, by 0.12 at one quarter and 0.08 at two. A penalised linear model on the same features is hard to beat one quarter out, and that is worth saying out loud. The GRU does beat the metro's own fifty year average at every horizon, which is the rule that matters: a long mean is a good guess at a trend and a bad one across a boom, and it degrades from 5.13 to 11.82 as the horizon doubles while the GRU goes 4.21 to 10.16.
- Ridge is the closest rival at eight quarters, 10.41 against 10.16. A quarter of a percentage point over two years is not a gap anyone should bet on, and the GRU's case at that horizon rests on its band being narrower, not on those 0.25 points. Gradient boosting used to hold that spot at 10.25 and now sits at 10.75, and the move was not a modelling change: one metro of 410 recovering its Zillow history in the panel was enough. A learner that swings half a point on 0.2 percent of the training metros is not one to read a tenth of a point from.
- The GRU earns its place on the bands. At four quarters its band is 29 percent narrower than the long run average's, at 0.87 coverage against 0.87. At eight quarters it is 36 percent narrower for 0.66 against 0.69.
- Every model under-covers at eight quarters, the GRU at 0.66 against a nominal 0.90, and the spread across models runs 0.54 to 0.72. That is the honest cost of a fixed calibration window, and it is read out in The Limits below rather than smoothed over.

The window MLP now beats no change at every horizon, which it did not before the two FHFA columns arrived, but it is behind the metro's own long run average at every horizon. It is kept as the honest answer to what a plain perceptron does here.

## The Shipped Forecast

The GRU refitted on every outcome realized by 2026Q2, at the epoch count found above. Its band margin is out of sample: a second GRU fitted through 2021, calibrated on 2022 to 2026, and that margin applied to the final quantiles.

![forecast fans](results/figures/11_forecast_fans.png)
![forecast distribution](results/figures/13_forecast_distribution.png)

At the 2026Q2 origin the median four quarter forecast across 410 metros is 3.8 percent (10th to 90th percentile 1.8 to 5.8). Five metros are forecast to fall, the weakest at minus 0.7. The eight quarter median is 8.6 percent.

| where | metros | four quarter |
|---|---|---|
| highest | Elmira, Weirton-Steubenville, Muncie, Kenosha, Lima | 7.2 to 8.8 percent |
| lowest | Cape Coral, Punta Gorda, Sherman-Denison, Austin, North Port | minus 0.7 to zero |
| Chicago division | | 6.2 percent, band -3.0 to 17.0 |

Every band is wide. That is the point of publishing one.

`export.py` writes the map's metrics contract to `results/forecast/metrics.csv`: expected growth at four and eight quarters with bands, realized growth over the last four, the five year annualized trend, the surprise, and the index standard error. The map shows them under Forecasts.

The index error is not a forecast and is credited to FHFA, not to the model. It rides in this file because nothing else on the map carries it, and it belongs beside a forecast because it says how firmly the thing being forecast is even measured. At 2026Q2 it runs from 0.05 percent in Denver and 0.06 in Phoenix, which are deep liquid markets, to 3.7 in Hinesville and 3.6 in Lawton, which are small and thinly traded. A wide error there is a reason to read the forecast above it loosely.

## The Limits

- The calibration block is fixed at 2018 to 2021 by choice, and every model under-covers at eight quarters because of it, 0.54 to 0.73 against a nominal 0.90. Conformal coverage is guaranteed only for exchangeable samples. Calibration outcomes land in 2018 to 2021, which is the run up and the boom; test outcomes land in 2022 onward, which is the correction. The two regimes are not exchangeable and no margin fitted on the first covers the second. Rolling the calibration window forward would fix it by calibrating on the period being scored, which is leakage, so the number is reported rather than repaired. A wider held out period, or a conformal method built for distribution shift, is the real answer.
- Zillow home values reach 2000 and cover 0.38 of the fitting block, so they are thin where the model learns. Unemployment and the mortgage rate used to be in that list and are not any more, because their sources could be pulled back further.
- Rents, listing prices and inventory are in the panel and on the map but out of reach of every model, and keeping their monthly history would not change that. All three are 0.00 of the fitting block at any sampling rate, so the fix is a later fitting era, not a better collector, and a later fitting era buys fewer years to learn from. `admit.py` makes that trade once, on the 2020 to 2021 block, and finds that permits and income repay it while rents and listings do not. Inventory starts 2020Q1 and cannot be measured at all without spending the block that would measure it.
- The band is very nearly one national width. At four quarters it runs 18.1 to 20.9 percentage points across all 410 metros, a standard deviation of 0.5 on a median of 19.3. That is the conformal step doing what it was built to do: `spec.apply_margin` adds one scalar per horizon to every metro alike, so all the per-metro variation has to come from the quantile heads, and they barely provide any. The model is now handed a published measurement error per metro, which is precisely the quantity that should widen a thin market's band and narrow a deep one's, and none of it reaches the band. A conformal method with a per-metro score, or a margin scaled by the index error, is the obvious next thing to try, and it has not been tried.
- A band that looks far too wide against one year is not too wide. The middle 90 percent of the misses at the 2025Q2 origin span about 9 points against a 20 point band, which invites the conclusion that the interval is doubled. It is not: the band has to cover where prices actually land, and across the whole test block the realized four quarter spread is 20.4 points against a median band of 17.9, which is why coverage is 0.87 and not 0.97. One origin's cross section is one draw of the cycle.
- The model separates metros less than it misses them. The cross metro standard deviation of the four quarter forecast is 1.5 points, well under the size of a typical miss. It does now forecast a fall, which it never did before the input set was cut to eleven: five metros are negative at the 2026Q2 origin, and they are Cape Coral, Punta Gorda, Sherman-Denison, Austin and North Port, which is a plausible list rather than a scattered one. Five out of 410 is still a model that mostly cannot say a particular metro is about to decline.
- The index standard error is fitted as index points, and FHFA rebases every metro to 100 at its own start, so the same number means different things in two metros. Expressed as a percent of the index it is scale free and slightly worse on validation, 0.006229 against 0.006204. The metro embedding is the likely reason the raw form survives, and the percent form is what ships to the map, where a reader is comparing metros and the model is not.

## The Layout

```
src/loop/      package code. spec.py is the contract every module imports
tests/         unittest suite, run with run_tests.py
results/       manifests, backtest tables, forecasts, figures. tracked
data/ models/  built panel and trained artifacts. gitignored
MILESTONES.md  the build plan
```

## The Roadmap

| wave | adds | status |
|---|---|---|
| forecasting | quarterly panel, backtest, five baselines, two torch models, conformal bands, map export | done |
| 1 baseline | features, ridge/lasso, gradient boosting, residual analysis | in progress |
| 2 scenarios | conditional sampling, then a small VAE if it earns its place | planned |
| 3 dashboard | streamlit app, public link | planned |

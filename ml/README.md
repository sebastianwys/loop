# ml

This folder forecasts how much each metro's house price index will move over the next 1, 2, 4 and 8 quarters, puts a range around each forecast, and sends the result to the map.

The model is a sequence GRU. I refit it every year from 2008 on and fed it FHFA prices as each release first printed them. Over the 34 quarterly origins whose outcomes land from 2018 on, it cut the error of a no change forecast by 43 percent at one year and 47 percent at two. Both cuts are significant in a paired Diebold-Mariano test. On 2022 onward alone the cut is 36 percent. Ridge regression and gradient boosting did about as well.

## How I built it

- Every sample goes in a block by the quarter its outcome lands in. Nothing realized after a cutoff reaches a model judged on later quarters.
- Every input waits for the date its source published it. FHFA revises old quarters, so the yearly refits read each release as it was first printed.
- I picked inputs on validation loss only, never on the test years. A gain smaller than the spread across random seeds did not count.
- I wrote the rules for replacing the model and the band before running the comparison. The rivals tied, so the GRU and the static band stayed.
- I compare models with a paired Diebold-Mariano test on the average error per quarter. The 410 metros forecast in the same quarter share one shock, so they count as one draw.

## Setup

```bash
cd ml
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -e .
.venv/bin/python run_tests.py
```

The full chain, from the repo root, takes about four minutes on an M4. Every step leaves a figure in `results/figures/`.

```bash
ml/.venv/bin/python -m loop.panel
ml/.venv/bin/python -m loop.baselines
ml/.venv/bin/python -m loop.train
ml/.venv/bin/python -m loop.export
ml/.venv/bin/python -m bot.build_map_data
```

The yearly refit record takes about 25 minutes per run. The price archive download needs `FRED_API_KEY`.

```bash
ml/.venv/bin/python scripts/download_fhfa_vintages.py
ml/.venv/bin/python -m loop.walkforward --vintage
ml/.venv/bin/python -m loop.walkforward
```

## The data

| item | value |
|---|---|
| input | `../data/integrated/hpi_census_merged.csv`, 1,204 rows by 24 columns, read only |
| sha256 | `b65d953f4c6beed7266be7da74292c45917d4c2fa404ba6414c402610dc18deb`, checked by the loader |
| metros | 410, including 37 metropolitan divisions |
| panel | one row per metro and quarter with the FHFA index and every source the bot collects, each held back to its publication date |
| target | log growth of the index over 1, 2, 4 and 8 quarters |

![how the backtest is split](results/figures/05_backtest_design.png)

| block | outcome lands | used for |
|---|---|---|
| train | by 2017Q4 | fitting, with 2015 to 2017 held back for validation |
| calibration | 2018 to 2021 | band width |
| test | 2022Q1 on | scored once |

## The models

Five simple rules set the bar: no change, momentum, the metro's own long run average, ridge regression and gradient boosting. Two neural networks read the same input. It holds 24 quarters of seven price and economic series with a mask for missing values, four annual features and a learned code for each metro. The window MLP flattens it and the sequence GRU reads it in order. Both predict the 10th, 50th and 90th percentile at every horizon and train on pinball loss with early stopping.

I compared input sets on validation loss, outcomes from 2015 to 2017. `ablate.py` reproduces the table. Each row is one seed. Five seeds of one set spread by up to 0.00027, so none of these gaps is a result.

| input set | validation loss |
|---|---|
| seven series, the shipped set | 0.006555 |
| expanded index, no error | 0.006548 |
| five series, no expanded index | 0.006575 |
| plus the metro against the cross section median | 0.006568 |
| plus the calendar quarter as a sine and cosine | 0.006574 |
| plus CPI, the ten year, the term spread and national unemployment | 0.006631 |

FHFA's expanded index covered 50 metros until its 2026Q1 report, so the backtest reads it only where it was published. It stays in because a forecast made today reads it for every metro.

Building permits and income start too late for the fitting years, so `admit.py` tests them on a later boundary: fitted through 2019, scored on 2020 and 2021, five seeds each.

| input set | series | validation loss, mean of five | spread of the five |
|---|---|---|---|
| the nine series | 9 | 0.013452 | 0.000182 |
| plus rents and listing prices | 11 | 0.013341 | 0.000144 |
| plus permits and income | 11 | 0.013277 | 0.000267 |
| all four | 13 | 0.013250 | 0.000181 |

Permits and income beat the nine on every seed and ship. Added to that set, rents and listing prices gain a tenth of the seed spread and stay out.

## The yearly refit record, 2018Q1 to 2026Q2

From 2008 on, each year's model fits on outcomes known by the end of the year before and forecasts every origin in its year. FHFA prices come from ALFRED, the St. Louis Fed's archive of past releases, 56 of them from May 2013 to August 2026. 379 of the 410 metros have their own series in it, and the other 31 keep today's index. The table shows mean absolute error in percentage points of growth over 34 quarterly origins. The p column is the paired test against the GRU at 1q, 2q, 4q and 8q.

| model | 1q | 2q | 4q | 8q | p against the gru |
|---|---|---|---|---|---|
| no change | 2.25 | 3.88 | 7.46 | 15.49 | <0.001 / 0.001 / <0.001 / <0.001 |
| momentum | 1.76 | 2.68 | 5.11 | 11.46 | 0.50 / 0.52 / 0.14 / 0.11 |
| metro mean | 1.82 | 2.81 | 4.70 | 9.30 | 0.14 / 0.28 / 0.34 / 0.41 |
| ridge | 1.60 | 2.36 | 4.70 | 8.04 | 0.11 / 0.30 / 0.35 / 0.46 |
| gradient boosting | 1.60 | 2.36 | 4.19 | 8.12 | 0.25 / 0.40 / 0.93 / 0.92 |
| window mlp | 1.80 | 2.82 | 5.18 | 10.79 | 0.02 / 0.04 / 0.02 / 0.04 |
| sequence gru | 1.71 | 2.55 | 4.23 | 8.20 | |
| gru and ridge averaged | 1.62 | 2.40 | 4.40 | 8.09 | 0.02 / 0.15 / 0.47 / 0.30 |

- The GRU cuts the no change error by 24, 34, 43 and 47 percent, significant at every horizon.
- On 2022 onward alone the cut is 14, 26, 36 and 36 percent, and only the one year gap is significant.
- Gradient boosting, ridge and the average are statistically tied with the GRU, and gradient boosting has the lower error at all four horizons. My rule, written before the run, weighs only ridge and the average. Either replaces the GRU only if it is better at three of four horizons at the 5 percent level and worse at none. Neither is, so the GRU stays.
- Run on today's revised prices instead, the GRU's error moves by 0.06 points or less.

The full tables are in `results/walkforward/vintage/` and `results/walkforward/latest/`.

## The fixed split, 2022Q1 to 2026Q2

The first test fitted every model once on outcomes through 2017 and scored it on 2022 onward. Coverage is the share of outcomes inside the 90 percent band.

| model | 1q | 2q | 4q | 8q | coverage 1q / 2q / 4q / 8q |
|---|---|---|---|---|---|
| no change | 2.30 | 3.72 | 7.66 | 18.05 | 0.87 / 0.91 / 0.86 / 0.68 |
| ridge | 1.88 | 2.54 | 4.50 | 10.54 | 0.81 / 0.90 / 0.86 / 0.63 |
| gradient boosting | 1.98 | 2.88 | 5.05 | 13.07 | 0.79 / 0.83 / 0.86 / 0.70 |
| sequence gru | 1.96 | 2.67 | 4.53 | 10.75 | 0.83 / 0.90 / 0.87 / 0.64 |

Here the GRU cuts the no change error by 41 percent at four quarters and 40 percent at eight (p 0.02 at both), tied with ridge.

![model comparison](results/figures/12_model_comparison.png)

## The bands

The 90 percent band uses conformalized quantile regression. It takes the model's 10th to 90th percentile range and widens it until 90 percent of the calibration outcomes fall inside. In the fixed split it covers 0.83 to 0.90 out to one year and 0.64 at two years. It was calibrated on 2018 to 2021, while prices ran up, and scored on the correction that came after.

In the yearly refit record I also tried an online band that recalibrates as each outcome lands, with a scale for each metro's volatility. On 2022 onward it covered 0.65 at two years against the static band's 0.54 in the same record. But it ran almost four times wider and scored worse on interval score at every horizon. My rule kept the static band.

## The shipped forecast

The GRU is refitted on every outcome through 2026Q2. Its band margin comes from a second GRU fitted through 2021 and calibrated on 2022 to 2026, so the margin is out of sample.

![forecast fans](results/figures/11_forecast_fans.png)

At the 2026Q2 origin the median four quarter forecast across 410 metros is 3.7 percent, with the 10th to 90th percentile running from 1.6 to 5.7. The eight quarter median is 8.7 percent. Five metros are forecast to fall over four quarters: Cape Coral, Punta Gorda, Sherman-Denison, Austin and North Port. The Chicago division's four quarter forecast is 6.1 percent, with a band from minus 3.7 to 17.7.

`export.py` writes `results/forecast/metrics.csv`, which the map shows under Forecasts.

## The limits

- The two year band covers 0.64 against a target of 0.90, and every model falls short the same way. Calibrating on the years being scored would fix the number by leaking, so I report it instead.
- The band is close to one national width. One margin per horizon covers all 410 metros, 19.4 to 22.3 points wide at four quarters.
- The model's four quarter forecasts spread 1.6 points across metros, less than a typical miss.
- Rents, listing prices and inventory start too late for the fitting years, so no model reads them.
- Only the FHFA index is replayed as first printed. Population and income come from later vintages. Refits before May 2013 read the archive's oldest release.

## The layout

```
src/loop/      package code. spec.py is the contract every module imports
tests/         unittest suite, run with run_tests.py
results/       backtest tables, the yearly refit record, forecasts, figures
data/ models/  built panel and trained artifacts, gitignored
MILESTONES.md  the original plan
```

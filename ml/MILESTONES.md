# Milestones

One milestone is one small unit of work: a test goes green, results land, commit, push the same day. Sized so each takes an evening or two. The "why" column is the sentence to say when someone asks about it.

## Wave 1: baseline

| # | milestone | done when | why |
|---|---|---|---|
| 1 | `data.py`: `load()` reads `../data/integrated/hpi_census_merged.csv` relative to the repo root, checks its sha256 against the constant in the module, returns a typed frame (cbsa_code str, year int, numerics numeric) and drops the constant hpi_type and hpi_flavor columns | test on the real file asserts 1,197 rows, 410 metros, 3 years; a tampered copy raises | the model never trains on a file nobody can reproduce, and a typed frame is the contract every later step relies on |
| 2 | `features.py`: one row per metro. hpi growth 2014 to 2019 and 2019 to 2024, income growth, pop growth, bachelors plus masters share of adults 25 and over, income to home value ratio, homeownership delta | tests on a hand-built 3-metro frame check each number | the features are the argument; the model is just the arithmetic |
| 3 | eda notebook: distributions, correlation matrix, top and bottom 10 metros by 2019 to 2024 growth | `results/visualizations/` holds distributions.png, correlations.png and top_bottom_metros.png; the readme embeds one | you should be able to talk about the data before the model |
| 4 | split rule: y is 2019 to 2024 growth, X is 2014 to 2019 changes plus 2019 levels. nothing from 2024 in X. split by metro with a fixed seed | a test asserts no 2024 column reaches X | leakage is the first thing a reviewer looks for |
| 5 | `models.py`: ridge and lasso with 5-fold cv over alpha. rmse, mae, r2 on the holdout to `results/baseline_metrics.json` | a test loads the json and asserts rmse, mae and r2 exist for ridge and lasso; the readme shows the table | a linear baseline is the bar everything else has to beat |
| 6 | gradient boosting (`HistGradientBoostingRegressor`) beside the linear models. permutation importance chart | importance png in results; metrics json gains a row | tells you whether nonlinearity buys anything here |
| 7 | residuals: metros the best model misses most, signed, to `results/residuals.csv` plus a chart | csv and png exist; the readme names the top 5 | this is question 2, and it is the interesting part |
| 8 | tag `ml-v0.1`. readme gets a results section with the metrics table and two charts | tag pushed | a citable checkpoint |

## Wave 2: scenarios

| # | milestone | done when | why |
|---|---|---|---|
| 9 | `scenarios.py`: shift a metro's features (income +10%, pop flat), rerun the fitted model, report the predicted change with a bootstrap interval from the residuals | test on one metro; a results table for 5 metros | a counterfactual with an honest interval, no neural net needed |
| 10 | small VAE on standardized feature vectors, cpu torch. sample 1,000 synthetic metros, compare marginals to the real ones | a chart of real vs sampled marginals, kept only if every marginal's ks statistic is under 0.1 | proves whether generative sampling adds anything over milestone 9 |
| 11 | tag `ml-v0.2` | tag pushed | |

## Wave 3: dashboard

| # | milestone | done when | why |
|---|---|---|---|
| 12 | streamlit app: metro picker, predicted vs actual, scenario sliders wired to `scenarios.py` | `streamlit run` serves it and a smoke test imports the app module | the thing you show, not tell |
| 13 | deploy to streamlit community cloud, link in the readme. tag `ml-v0.3` | public url returns 200 | |

## Done outside the waves

metropolitan division crosswalk, c3af214. Recovered the 37 fhfa divisions the pipeline could not match (chicago, nyc, la sub-markets). The panel went from 1,101 rows and 373 metros to 1,197 and 410, which put the biggest markets in the training set.

## Optional

| milestone | why |
|---|---|
| refresh with the 2025 acs vintage when it publishes | keeps the project alive past the first release |

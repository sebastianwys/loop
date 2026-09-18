# shared definitions for the forecasting work. every module reads its paths,
# horizons, split dates, target and error measures from here, so the panel,
# the baselines, the torch models and the export all mean the same thing

from pathlib import Path

import numpy as np
import pandas as pd

ML_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = ML_ROOT.parent
RAW_DIR = REPO_ROOT / "data" / "raw"
PANEL_PATH = ML_ROOT / "data" / "panel.parquet"
PANEL_MANIFEST = ML_ROOT / "results" / "panel_manifest.json"
FIGURES_DIR = ML_ROOT / "results" / "figures"
BACKTEST_DIR = ML_ROOT / "results" / "backtest"
FORECAST_DIR = ML_ROOT / "results" / "forecast"
MODELS_DIR = ML_ROOT / "models"

# quarters ahead a forecast reaches, and the quantiles a model reports
HORIZONS = (1, 2, 4, 8)
QUANTILES = (0.1, 0.5, 0.9)
ALPHA = 0.1
WINDOW = 24
SEED = 20260915

# time blocks by outcome quarter. a sample is one metro at one origin quarter
# for one horizon, and belongs to the block where its outcome is realized:
# train when the outcome lands by TRAIN_END, calibration when it lands in the
# calibration years, test when it lands at or after TEST_START. the outcome
# decides it and nothing else, so one origin can sit in different blocks at
# different horizons, which is the horizon moving the outcome. nothing realized
# after 2021 reaches a model that is judged on 2022 onward
TRAIN_END = "2017Q4"
# the tail of the train block is held out to choose epochs and inputs, so the
# block a model actually FITS on ends the quarter before this. that is the
# boundary that decides whether a feature can be learned at all, and it lives
# here rather than in train.py because the panel figures draw it too
VAL_START = "2015Q1"
FIT_END = "2014Q4"
CAL_START = "2018Q1"
CAL_END = "2021Q4"
TEST_START = "2022Q1"

# the panel contract. keys, then the columns every consumer may rely on.
# a producer writes every column, null where a source has no value
KEY = ["cbsa_code", "quarter"]
STATIC = ["name", "level", "parent_cbsa", "date"]
TARGET_BASE = "log_hpi"
LEVELS = ["hpi", "log_hpi", "hpi_exp", "unemp", "mortgage", "zhvi", "zori"]
FEATURES = [
    "hpi_qoq",
    "hpi_yoy",
    "unemp",
    "mortgage",
    "zhvi_yoy",
    "permits_per_1000",
    "pop_growth",
    "domestic_migration_rate",
    "income_growth",
    # fhfa's second estimate of the same metro quarter and the standard error
    # it publishes with it. both reach back to 1991, which is where the fitting
    # block lives, unlike every covariate above: unemployment reaches 82 percent
    # of the fitting samples and the rest under 10. adding these cut the
    # validation loss from 0.006564 to 0.006202
    "hpi_exp_yoy",
    "hpi_rstderr",
]

# columns the panel carries that no model reads. each was built for the same
# reason as the two above, tried on the validation block and rejected there:
# the calendar quarter 0.006565, the metro against the cross section 0.006565,
# the four national series 0.006618, against a 0.006564 without them. a
# national series is the same number in all 410 metros, so it teaches the
# window which era it sits in and nothing about the place. they stay in the
# panel because the figures and the map read them, and because a negative
# result that is easy to re-run is worth more than one written down
#
# rents, listing prices and inventory joined them on 2026-09-18. they had
# never been through this gate at all: feature_stats takes its seen mask from
# the FITTING block, which ends 2014Q4, and to_tensors then blanks an unseen
# feature in every window including the one that would score it, so both arms
# of an ablation saw the same zeros. ml/admit.py measures them at a boundary
# where they are visible, fitting through 2019Q4 and scoring on 2020 and 2021.
# adding permits and income to the nine recovers the whole gain; adding rents
# and listings recovers a thirtieth of it, inside the seed spread. inventory
# starts 2020Q1, so no fitting window can see it without eating the block that
# would score it, and it is dropped as unmeasurable rather than kept unmeasured
CONTEXT = [
    "zori_yoy",
    "listing_price_yoy",
    "inventory_yoy",
    "hpi_rstderr_rel",
    "hpi_yoy_rel",
    "cpi_yoy",
    "treasury_10y",
    "term_spread",
    "natl_unemp",
    "quarter_sin",
    "quarter_cos",
]
PANEL_COLUMNS = KEY + STATIC + LEVELS + [c for c in FEATURES + CONTEXT if c not in LEVELS]

# metros the walkthrough charts name, chosen to span the map: the two chicago
# pieces, sun belt boom towns, a mountain town, a coastal giant and a rust
# belt anchor
SHOWCASE = {
    "16984": "Chicago division",
    "12420": "Austin",
    "14260": "Boise",
    "14580": "Bozeman",
    "34980": "Nashville",
    "38060": "Phoenix",
    "41884": "San Francisco division",
    "38300": "Pittsburgh",
}


def to_period(quarter):
    return pd.Period(quarter, freq="Q")


def shift_quarter(quarter, steps):
    return str(to_period(quarter) + steps)


def quarter_end(quarter):
    return to_period(quarter).end_time.normalize()


def quarter_of(date):
    return str(pd.Timestamp(date).to_period("Q"))


# the target is log growth of the house price index over h quarters, so a
# value of 0.05 means about five percent. pct() turns it into a percent
def target(frame, horizon):
    frame = frame.sort_values(KEY)
    # the outcome is the quarter the calendar names, looked up by key. counting
    # rows ahead instead overshot it whenever a metro was missing a quarter in
    # between, and nulled a target both endpoints could support
    level = frame.set_index(["cbsa_code", "quarter"])[TARGET_BASE]
    wanted = pd.MultiIndex.from_arrays([
        frame["cbsa_code"].to_numpy(),
        frame["quarter"].map(lambda q: shift_quarter(q, horizon)).to_numpy(),
    ])
    ahead = level.reindex(wanted).to_numpy(dtype=float)
    return pd.Series(ahead - frame[TARGET_BASE].to_numpy(dtype=float), index=frame.index)


def pct(log_growth):
    return 100.0 * (np.exp(np.asarray(log_growth, dtype=float)) - 1.0)


# which block a sample falls in. the outcome quarter decides it and nothing
# else, so a sample belongs to the block its outcome is realized in. reading
# cal and test off the origin instead left only the 2020 to 2021 boom in the
# calibration set at eight quarters, and discarded every sample whose outcome
# crossed a boundary
def block(origin, horizon):
    outcome = to_period(origin) + horizon
    if outcome <= to_period(TRAIN_END):
        return "train"
    if outcome <= to_period(CAL_END):
        return "cal"
    return "test"


def mae(y, yhat):
    y, yhat = _pair(y, yhat)
    return float(np.mean(np.abs(y - yhat)))


def rmse(y, yhat):
    y, yhat = _pair(y, yhat)
    return float(np.sqrt(np.mean((y - yhat) ** 2)))


# error relative to the no change forecast on the same samples. below one
# beats saying prices stay flat
def relative_mae(y, yhat):
    y, yhat = _pair(y, yhat)
    naive = np.mean(np.abs(y))
    return float(np.mean(np.abs(y - yhat)) / naive) if naive > 0 else float("nan")


def pinball(y, q_hat, q):
    y, q_hat = _pair(y, q_hat)
    diff = y - q_hat
    return float(np.mean(np.maximum(q * diff, (q - 1.0) * diff)))


def coverage(y, lo, hi):
    y = np.asarray(y, dtype=float)
    lo = np.asarray(lo, dtype=float)
    hi = np.asarray(hi, dtype=float)
    keep = ~(np.isnan(y) | np.isnan(lo) | np.isnan(hi))
    if keep.sum() == 0:
        return float("nan")
    return float(np.mean((y[keep] >= lo[keep]) & (y[keep] <= hi[keep])))


def mean_width(lo, hi):
    lo = np.asarray(lo, dtype=float)
    hi = np.asarray(hi, dtype=float)
    keep = ~(np.isnan(lo) | np.isnan(hi))
    return float(np.mean(hi[keep] - lo[keep])) if keep.any() else float("nan")


# split conformal on a calibration block: the smallest widening that makes the
# band cover at least a 1 - alpha share of the calibration outcomes, with the
# finite sample correction from romano, patterson and candes (2019)
def conformal_margin(y, lo, hi, alpha=ALPHA):
    y = np.asarray(y, dtype=float)
    lo = np.asarray(lo, dtype=float)
    hi = np.asarray(hi, dtype=float)
    keep = ~(np.isnan(y) | np.isnan(lo) | np.isnan(hi))
    scores = np.maximum(lo[keep] - y[keep], y[keep] - hi[keep])
    n = scores.size
    if n == 0:
        return float("nan")
    rank = min(int(np.ceil((n + 1) * (1 - alpha))), n)
    return float(np.sort(scores)[rank - 1])


# the margin is one scalar for a whole horizon and the rows it lands on carry
# their own widths, so a negative margin, which is the right answer for a band
# that was already too wide, can push lo past hi on the narrow rows. an
# inverted band is not a band: it reports zero coverage and a negative width.
# collapse those rows onto the raw band's midpoint and say how many there were
def apply_margin(lo, hi, margin):
    lo = np.asarray(lo, dtype=float) - margin
    hi = np.asarray(hi, dtype=float) + margin
    crossed = lo > hi
    mid = (lo + hi) / 2.0
    return np.where(crossed, mid, lo), np.where(crossed, mid, hi), crossed


def _pair(y, yhat):
    y = np.asarray(y, dtype=float)
    yhat = np.asarray(yhat, dtype=float)
    keep = ~(np.isnan(y) | np.isnan(yhat))
    return y[keep], yhat[keep]

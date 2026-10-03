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
# block a model actually fits on ends the quarter before this. that is the
# boundary that decides whether a feature can be learned at all, and it lives
# here rather than in train.py because the panel figures draw it too
VAL_START = "2015Q1"
FIT_END = "2014Q4"
CAL_START = "2018Q1"
CAL_END = "2021Q4"
TEST_START = "2022Q1"

# the blocks are read off their end dates and the figures off their start
# dates, so each start has to be the quarter after the end before it. an edit
# that moves one and not the other stops here instead of moving a caption
def check_calendar(pairs):
    for end, start in pairs:
        if pd.Period(end, freq="Q") + 1 != pd.Period(start, freq="Q"):
            raise ValueError(f"{start} is not the quarter after {end}")


CALENDAR = ((FIT_END, VAL_START), (TRAIN_END, CAL_START), (CAL_END, TEST_START))
check_calendar(CALENDAR)

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
    # fhfa's second estimate of the same metro quarter and the relative
    # standard error it publishes with it, back to 1991. fhfa published them for
    # 50 metros until its 2026Q1 report and for all 410 since, so the shipped
    # forecast reads them everywhere and anything scored on the past reads them
    # only for the 50, through realtime() below. on fhfa's 2026 history they cut
    # the validation loss from 0.006567 to 0.006204, but 94 percent of that came
    # from the 360 metros no model could have read before 2026
    "hpi_exp_yoy",
    "hpi_rstderr",
]

# the same eleven split by how a network reads them: a sequence over the window,
# or one value at the origin. nets owns the tensors, but the split is contract,
# because the panel manifest publishes it and the web page quotes the counts
SEQ_FEATURES = ["hpi_qoq", "hpi_yoy", "unemp", "mortgage", "zhvi_yoy", "hpi_exp_yoy", "hpi_rstderr"]
STATIC_FEATURES = ["permits_per_1000", "pop_growth", "domestic_migration_rate", "income_growth"]

# columns the panel carries that no model reads. each was built for the same
# reason as the two above, tried on the validation block and not kept: the four
# national series cost 0.006617 against 0.006204 with the shipped set. that is
# a real loss, because one number shared by all 410 metros teaches a window
# which era it sits in and nothing about the place. the calendar quarter at
# 0.006566 and the metro against the cross section at 0.006561 both land inside
# the spread five seeds of one set produce. a margin that thin is a coin, so
# the simpler set stays. they are all in the panel because the figures and
# the map read them, and because a negative result that is easy to rerun is
# worth more than one written down
#
# rents, listing prices and inventory joined them on 2026-09-18. they had
# never been through this gate at all: feature_stats takes its seen mask from
# the fitting block, which ends 2014Q4, and to_tensors then blanks an unseen
# feature in every window including the one that would score it, so both arms
# of an ablation saw the same zeros. ml/admit.py measures them at a boundary
# where they are visible, fitting through 2019Q4 and scoring on 2020 and 2021.
# adding permits and income to the nine recovers the whole gain. adding rents
# and listings recovers a thirtieth of it, inside the seed spread. inventory
# starts 2020Q1, so no fitting window can see it without eating the block that
# would score it, and it is dropped as unmeasurable rather than kept unmeasured
CONTEXT = [
    "zori_yoy",
    "listing_price_yoy",
    "inventory_yoy",
    "hpi_yoy_rel",
    "cpi_yoy",
    "treasury_10y",
    "term_spread",
    "natl_unemp",
    "quarter_sin",
    "quarter_cos",
]
PANEL_COLUMNS = KEY + STATIC + LEVELS + [c for c in FEATURES + CONTEXT if c not in LEVELS]

# the quarter of year y + 1 from which an annual value for year y is known, by
# when each publisher releases it. pep reaches metros in march, bps posts its
# annual files in may and bea county income comes out in november. a quarter
# counts as known when the release lands before the quarter ends
PUBLISHED_IN_QUARTER = {
    "pop_growth": 1,
    "domestic_migration_rate": 1,
    "permits_per_1000": 2,
    "income_growth": 4,
}

# a release that came out later than its source's rule says. bea's 2024 county
# income came out on 2026-02-05, after the shutdown, so no quarter of 2025 had it
PUBLISHED_LATE = {"income_growth": {2024: "2026Q1"}}

# fhfa's expanded data index covered 25 metros from 2012 and 50 from 2018, and
# reached 410 with the 2026Q1 report (fhfa technical note 2026m01). these are
# the 50, as this repo pulled them before 2026. a backtest fits on outcomes
# through 2017 and was chosen in 2018, when these 50 were published with their
# history back to 1991, so they stay visible at every quarter
EXPANDED_BEFORE_2026 = frozenset({
    "11244", "11694", "12054", "12420", "12580", "14454", "15764", "16740", "16984", "17140",
    "17410", "18140", "19124", "19740", "19804", "22744", "23104", "26420", "26900", "27260",
    "28140", "29484", "29820", "31084", "33124", "33340", "33460", "33874", "34980", "35004",
    "35084", "35614", "36084", "36740", "37964", "38060", "38300", "38900", "39300", "40140",
    "40900", "41180", "41700", "41740", "41940", "42644", "45294", "47260", "47664", "47764",
})
EXPANDED_FOR_ALL_FROM = "2026Q1"
EXPANDED_INPUTS = ("hpi_exp_yoy", "hpi_rstderr")


# the panel as a model scored on the past could have read it. the backtest,
# the band model and every feature experiment read this view, the shipped
# forecast reads the full panel because fhfa publishes all 410 now. a row is
# masked by its own quarter, which is conservative for an origin past 2026Q1
def realtime(panel):
    out = panel.copy()
    quarter = pd.PeriodIndex(out["quarter"].astype(str), freq="Q")
    hidden = ~out["cbsa_code"].astype(str).isin(EXPANDED_BEFORE_2026) & (quarter < to_period(EXPANDED_FOR_ALL_FROM))
    for column in EXPANDED_INPUTS:
        if column in out.columns:
            out.loc[hidden, column] = np.nan
    return out

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

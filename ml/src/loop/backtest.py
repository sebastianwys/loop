# the evaluation frame every forecasting model shares: samples by origin and
# horizon, the inputs known at an origin, a leakage check, split conformal
# calibration and one summary table. models only add the q10, q50, q90 columns

import numpy as np
import pandas as pd

from loop import spec

LAGS = 8
LAG_COLUMNS = [f"lag{i}" for i in range(LAGS)]
FEATURE_COLUMNS = LAG_COLUMNS + ["qoq_mean", "national_yoy"] + spec.FEATURES
SAMPLE_COLUMNS = ["cbsa_code", "quarter", "horizon", "block", "y"]
PREDICTION_COLUMNS = ["model"] + SAMPLE_COLUMNS + ["q10", "q50", "q90", "lo", "hi"]
SUMMARY_COLUMNS = [
    "model", "horizon", "block", "n", "mae", "rmse", "relative_mae",
    "pinball_10", "pinball_50", "pinball_90", "coverage_raw", "coverage", "width", "mae_pct",
]
MARGIN_COLUMNS = ["model", "horizon", "n_cal", "margin", "crossed"]
BLOCKS = ("train", "cal", "test")


# the path is read at call time, not captured in the default: bound there, a
# test that redirects spec.PANEL_PATH still reads the production panel
def load_panel(path=None):
    panel = pd.read_parquet(spec.PANEL_PATH if path is None else path)
    missing = [c for c in spec.PANEL_COLUMNS if c not in panel.columns]
    if missing:
        raise ValueError(f"panel lacks columns {missing}")
    panel["cbsa_code"] = panel["cbsa_code"].astype(str)
    return panel.sort_values(spec.KEY).reset_index(drop=True)


# one row per metro and origin with the realized outcome. origins whose outcome
# would land in a gap between blocks, or past the end of the panel, are dropped
def samples(panel, horizon):
    frame = panel[spec.KEY + [spec.TARGET_BASE]].sort_values(spec.KEY).reset_index(drop=True)
    blocks = {q: spec.block(q, horizon) for q in frame["quarter"].unique()}
    out = pd.DataFrame({
        "cbsa_code": frame["cbsa_code"],
        "quarter": frame["quarter"],
        "horizon": horizon,
        "block": frame["quarter"].map(blocks),
        "y": spec.target(frame, horizon),
    })
    out = out[out["block"].notna() & out["y"].notna()]
    return out.reset_index(drop=True)


# every metro on a full quarter grid, so a missing quarter breaks a lag instead
# of pairing the wrong quarters
def _grid(frame):
    if frame.duplicated(spec.KEY).any():
        raise ValueError("panel has more than one row for a metro and quarter")
    quarters = [str(p) for p in pd.period_range(frame["quarter"].min(), frame["quarter"].max(), freq="Q")]
    index = pd.MultiIndex.from_product([sorted(frame["cbsa_code"].unique()), quarters], names=spec.KEY)
    return frame.set_index(spec.KEY).reindex(index)


# the model inputs known at an origin: the last eight quarterly growth rates,
# the metro's own average growth so far, the cross metro pulse and every panel
# feature at the origin. nulls stay nulls, each model decides how to fill them
def features_at_origin(panel):
    columns = list(dict.fromkeys(["hpi_qoq", "hpi_yoy"] + spec.FEATURES))
    frame = panel[spec.KEY + columns].sort_values(spec.KEY)
    grid = _grid(frame)
    by_metro = grid.groupby(level="cbsa_code", sort=False)
    out = pd.DataFrame(index=grid.index)
    for i in range(LAGS):
        out[f"lag{i}"] = by_metro["hpi_qoq"].shift(i)
    qoq = grid["hpi_qoq"]
    total = qoq.fillna(0.0).groupby(level="cbsa_code", sort=False).cumsum()
    count = qoq.notna().astype(float).groupby(level="cbsa_code", sort=False).cumsum()
    out["qoq_mean"] = total / count.where(count > 0)
    out["national_yoy"] = grid["hpi_yoy"].groupby(level="quarter", sort=False).transform("mean")
    for col in spec.FEATURES:
        out[col] = grid[col]
    out = out.loc[pd.MultiIndex.from_frame(frame[spec.KEY])]
    return out.reset_index()[spec.KEY + FEATURE_COLUMNS]


# samples for every horizon joined with the features at their origin
def dataset(panel, horizons=spec.HORIZONS):
    features = features_at_origin(panel)
    parts = [samples(panel, h) for h in horizons]
    frame = pd.concat(parts, ignore_index=True)
    return frame.merge(features, on=spec.KEY, how="left", validate="many_to_one")


# a feature built at origin t may not change when the panel stops at t. this
# recomputes the builder on a truncated panel for a few sampled origins and
# compares. it catches use of later rows, not a value stamped at t that was
# only published later, which is the panel builder's job
def assert_no_leakage(panel, features, horizon, builder=features_at_origin, n=5, seed=spec.SEED):
    rng = np.random.default_rng(seed)
    pool = samples(panel, horizon)
    # min(n, len(pool)) over an empty pool checks nothing and still passes
    if pool.empty:
        raise AssertionError(f"no samples at horizon {horizon}, so nothing was checked")
    picks = pool.iloc[rng.choice(len(pool), size=min(n, len(pool)), replace=False)]
    columns = [c for c in features.columns if c not in spec.KEY]
    full = features.set_index(spec.KEY)
    for code, origin in zip(picks["cbsa_code"], picks["quarter"]):
        seen = panel[panel["quarter"] <= origin]
        redo = builder(seen).set_index(spec.KEY)
        absent = [c for c in columns if c not in redo.columns]
        if absent:
            raise AssertionError(f"columns {absent} vanish when the panel stops at {origin}")
        before = full.loc[(code, origin), columns].to_numpy(dtype=float)
        after = redo.loc[(code, origin), columns].to_numpy(dtype=float)
        same = np.isclose(before, after, equal_nan=True)
        if not same.all():
            bad = [c for c, ok in zip(columns, same) if not ok]
            raise AssertionError(f"features {bad} at {code} {origin} change when the panel stops at {origin}")


# a model's three quantiles may cross, sort them so q10 <= q50 <= q90
def sort_quantiles(predictions):
    frame = predictions.copy()
    q = np.sort(frame[["q10", "q50", "q90"]].to_numpy(dtype=float), axis=1)
    frame["q10"], frame["q50"], frame["q90"] = q[:, 0], q[:, 1], q[:, 2]
    return frame


def _with_model(predictions, model):
    frame = predictions.copy()
    if model is not None:
        frame["model"] = model
    if "model" not in frame.columns:
        raise ValueError("predictions need a model column or a model name")
    return frame


# split conformal on the cal block: one margin per model and horizon widens
# q10 and q90 into lo and hi for every block. on exchangeable data this covers
# at least 1 - alpha of new outcomes. quarters are not exchangeable, the cal
# years and the test years are different regimes, so the coverage on the test
# block is the honest number to report, not the guarantee
def calibrate(predictions, model=None, alpha=spec.ALPHA):
    # a frame concatenated from several models carries repeated index labels,
    # and .loc on a repeated label writes more rows than the group has
    frame = _with_model(predictions, model).reset_index(drop=True)
    frame["lo"] = frame["q10"]
    frame["hi"] = frame["q90"]
    rows = []
    for (name, horizon), group in frame.groupby(["model", "horizon"], sort=False):
        cal = group[group["block"] == "cal"]
        margin = spec.conformal_margin(cal["y"], cal["q10"], cal["q90"], alpha)
        # a margin of 0.0 standing in for a margin that could not be computed
        # reads exactly like a model that needed no widening, so refuse it
        if not np.isfinite(margin):
            raise ValueError(
                f"{name} at horizon {horizon} has no realized outcome on the cal "
                "block, so its band has nothing to calibrate on"
            )
        lo, hi, crossed = spec.apply_margin(group["q10"], group["q90"], margin)
        frame.loc[group.index, "lo"] = lo
        frame.loc[group.index, "hi"] = hi
        rows.append({
            "model": name,
            "horizon": horizon,
            "n_cal": int(cal["y"].notna().sum()),
            "margin": margin,
            "crossed": int(crossed.sum()),
        })
    return frame[PREDICTION_COLUMNS], pd.DataFrame(rows, columns=MARGIN_COLUMNS)


# one row per model, horizon and block. every error is in log growth units
# except mae_pct, which is in percentage points of growth
def evaluate(predictions, model=None):
    frame = _with_model(predictions, model)
    for col in ("lo", "hi"):
        if col not in frame.columns:
            frame[col] = frame["q10" if col == "lo" else "q90"]
    order = {name: i for i, name in enumerate(dict.fromkeys(frame["model"]))}
    rows = []
    for (name, horizon, block), g in frame.groupby(["model", "horizon", "block"], sort=False):
        y = g["y"].to_numpy(dtype=float)
        q50 = g["q50"].to_numpy(dtype=float)
        keep = ~(np.isnan(y) | np.isnan(q50))
        rows.append({
            "model": name,
            "horizon": int(horizon),
            "block": block,
            "n": int(keep.sum()),
            "mae": spec.mae(y, q50),
            "rmse": spec.rmse(y, q50),
            "relative_mae": spec.relative_mae(y, q50),
            "pinball_10": spec.pinball(y, g["q10"], 0.1),
            "pinball_50": spec.pinball(y, q50, 0.5),
            "pinball_90": spec.pinball(y, g["q90"], 0.9),
            "coverage_raw": spec.coverage(y, g["q10"], g["q90"]),
            "coverage": spec.coverage(y, g["lo"], g["hi"]),
            "width": spec.mean_width(g["lo"], g["hi"]),
            "mae_pct": float(np.mean(np.abs(spec.pct(y[keep]) - spec.pct(q50[keep])))) if keep.any() else float("nan"),
        })
    out = pd.DataFrame(rows, columns=SUMMARY_COLUMNS)
    rank = out["model"].map(order)
    position = out["block"].map({b: i for i, b in enumerate(BLOCKS)})
    out = out.assign(_m=rank, _b=position).sort_values(["_m", "horizon", "_b"]).drop(columns=["_m", "_b"])
    return out.reset_index(drop=True)


def write_summary(frame, name):
    spec.BACKTEST_DIR.mkdir(parents=True, exist_ok=True)
    path = spec.BACKTEST_DIR / f"{name}.csv"
    frame.to_csv(path, index=False)
    return path


def write_predictions(frame, name):
    folder = spec.ML_ROOT / "data"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"predictions_{name}.parquet"
    frame.to_parquet(path, index=False)
    return path

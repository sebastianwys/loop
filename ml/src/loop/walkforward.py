# the backtest refitted once a year on what had been realized by then. the
# model for year Y fits on outcomes realized by the end of Y-1 and forecasts
# every origin in Y, so each forecast is out of sample for the model that made
# it, and the scored record runs from FIRST_YEAR instead of from one split. the
# networks pick their epoch count on the last VAL_YEARS realized years and are
# then refitted on everything realized. every model reads the panel as it could
# have been read at the time
#
# from ml:  .venv/bin/python -m loop.walkforward [model ...]

import sys
import time

import numpy as np
import pandas as pd

from loop import backtest, baselines, nets, spec, train, vintages

FIRST_YEAR = 2008
VAL_YEARS = 3
CLASSICAL = tuple(baselines.MODELS)
NETWORKS = tuple(train.MODELS)
MODELS = CLASSICAL + NETWORKS
CACHE_DIR = spec.ML_ROOT / "data" / "walkforward"


# the last quarter whose outcome a model for year Y may fit on
def cutoff(year):
    return spec.to_period(f"{year - 1}Q4")


def ordinals(quarters):
    return pd.PeriodIndex(pd.Series(quarters).astype(str), freq="Q").asi8


def years(last_quarter):
    return list(range(FIRST_YEAR, spec.to_period(str(last_quarter)).year + 1))


def with_blocks(frame):
    labels = [spec.block(q, int(h)) for q, h in zip(frame["quarter"], frame["horizon"])]
    return frame.assign(block=labels)


# the five classical models are fitted by baselines itself: rows realized by
# the cutoff are labelled train and the year's origins are what it predicts,
# so every rule, its band and ridge's alpha come from the past alone
def classical_year(data, name, year, vint=None):
    origin = ordinals(data["quarter"])
    realized = data["y"].notna().to_numpy() & (origin + data["horizon"].to_numpy() <= cutoff(year).ordinal)
    now = (origin >= spec.to_period(f"{year}Q1").ordinal) & (origin <= spec.to_period(f"{year}Q4").ordinal)
    rows = realized | now
    sub = data[rows].copy()
    sub["block"] = np.where(realized[rows], "train", "now")
    if vint is not None:
        # the rules learn from outcomes as the refit's release printed them,
        # and are scored below on today's
        truth = sub["y"].copy()
        learn = sub["block"] == "train"
        printed = vintages.printed_growth(vint, vintages.release_for_refit(vint, year), sub.loc[learn, "cbsa_code"],
                                          sub.loc[learn, "quarter"], sub.loc[learn, "horizon"])
        sub.loc[learn, "y"] = np.where(np.isnan(printed), sub.loc[learn, "y"], printed)
    predicted = baselines.MODELS[name](sub)
    if vint is not None:
        predicted["y"] = truth.to_numpy()
    out = predicted[(predicted["block"] == "now") & predicted["y"].notna()]
    return with_blocks(out.drop(columns=["block"]))[backtest.PREDICTION_COLUMNS]


def network_frame(windows, pred, idx, name):
    parts = []
    for j, h in enumerate(spec.HORIZONS):
        keep = ~np.isnan(windows.y[idx, j])
        sel = idx[keep]
        part = pd.DataFrame({
            "cbsa_code": windows.codes[sel],
            "quarter": windows.origins[sel],
            "horizon": h,
            "y": windows.y[sel, j].astype(float),
        })
        for k, q in enumerate(spec.QUANTILES):
            part[train.qname(q)] = pred[keep, j, k].astype(float)
        parts.append(part)
    frame = pd.concat(parts, ignore_index=True)
    frame["lo"], frame["hi"], frame["model"] = frame["q10"], frame["q90"], name
    return with_blocks(frame)[backtest.PREDICTION_COLUMNS]


def network_year(windows, name, year, device=None, vint=None):
    outcome = windows.t[:, None] + np.asarray(spec.HORIZONS)[None, :]
    realized = ~np.isnan(windows.y)
    end = windows.index_of(str(cutoff(year)))
    val_from = end - 4 * VAL_YEARS + 1
    fit = realized & (outcome < val_from)
    val = realized & (outcome >= val_from) & (outcome <= end)
    learn = windows.y
    if vint is not None:
        # outcomes as the refit's release printed them. scoring below keeps
        # today's, through windows.y
        release = vintages.release_for_refit(vint, year)
        learn = np.array(windows.y, dtype=float, copy=True)
        for j, h in enumerate(spec.HORIZONS):
            printed = vintages.printed_growth(vint, release, windows.codes, windows.origins, np.full(len(windows), h))
            learn[:, j] = np.where(np.isnan(printed), learn[:, j], printed)
    first = train.train_one(name, windows, np.where(fit, learn, np.nan), np.where(val, learn, np.nan),
                            device, verbose=False)
    final = train.train_one(name, windows, np.where(fit | val, learn, np.nan), None, device,
                            epochs=first["epochs"], verbose=False)
    origin_year = pd.PeriodIndex(pd.Series(windows.origins).astype(str), freq="Q").year.to_numpy()
    idx = np.nonzero((origin_year == year) & realized.any(axis=1))[0]
    pred = train.predict(final["model"], final["inputs"], idx, final["device"])
    return network_frame(windows, pred, idx, name), first["epochs"]


# the two readings of the record: prices as fhfa prints them today, and as
# each release printed them at the time
VARIANTS = ("latest", "vintage")


def suffix(variant):
    return "" if variant == "latest" else f"_{variant}"


def cached(name, year, variant="latest"):
    return CACHE_DIR / f"{name}{suffix(variant)}_{year}.parquet"


# every year of one model, each written as it finishes so a stopped run
# resumes where it was
def run_model(name, panel, device=None, log=print, variant="latest"):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    view = spec.realtime(panel)
    vint = vintages.Vintages.load() if variant == "vintage" else None
    data = windows = None
    parts = []
    for year in years(panel["quarter"].max()):
        path = cached(name, year, variant)
        if path.exists():
            parts.append(pd.read_parquet(path))
            continue
        started = time.perf_counter()
        if name in CLASSICAL:
            if data is None:
                data = backtest.dataset(view)
                data = vintages.overlay_dataset(data, vint) if vint is not None else data
            frame, note = classical_year(data, name, year, vint), ""
        else:
            if windows is None:
                windows = nets.build_windows(view)
                windows = vintages.overlay_windows(windows, vint) if vint is not None else windows
            frame, epochs = network_year(windows, name, year, device, vint)
            note = f", {epochs} epochs"
        frame.to_parquet(path, index=False)
        parts.append(frame)
        log(f"{name}{suffix(variant)} {year}: {len(frame)} forecasts in {time.perf_counter() - started:.0f}s{note}")
    out = pd.concat(parts, ignore_index=True)
    out.to_parquet(spec.ML_ROOT / "data" / f"walkforward_{name}{suffix(variant)}.parquet", index=False)
    return out


# the windows the record is read in. band settings are chosen on outcomes in
# TUNE, every model and the band are scored on RECORD, which starts after the
# networks' settings were chosen, and TEST is the fixed split's test block for
# comparison with it
TUNE = ("2012Q1", "2017Q4")
RECORD = ("2018Q1", None)
TEST = ("2022Q1", None)
BAND_GRID = [(gamma, window, scaled) for gamma in (0.0, 0.01, 0.05) for window in (16, 40, None)
             for scaled in (False, True)]
ENSEMBLE = ("seqgru", "ridge")


def load(name, variant="latest"):
    return pd.read_parquet(spec.ML_ROOT / "data" / f"walkforward_{name}{suffix(variant)}.parquet")


# the gru and ridge averaged quantile by quantile on the forecasts both made
def ensemble(first, second, name="ensemble"):
    key = ["cbsa_code", "quarter", "horizon"]
    both = first.merge(second[key + ["q10", "q50", "q90"]], on=key, suffixes=("", "_b"))
    for q in ("q10", "q50", "q90"):
        both[q] = (both[q] + both[f"{q}_b"]) / 2.0
    both["lo"], both["hi"], both["model"] = both["q10"], both["q90"], name
    return backtest.order_quantiles(both[backtest.PREDICTION_COLUMNS])


def within(frame, span):
    u = ordinals(frame["quarter"]) + frame["horizon"].to_numpy()
    first, last = span
    keep = u >= spec.to_period(first).ordinal
    if last is not None:
        keep &= u <= spec.to_period(last).ordinal
    return frame[keep]


# the band settings for one model and horizon: the online band run over the
# whole record, since a band only ever reads outcomes realized before it, and
# the setting with the lowest mean interval score on TUNE kept
def choose_band(frame, scale):
    best = None
    for gamma, window, scaled in BAND_GRID:
        banded = backtest.online_bands(frame, gamma=gamma, window=window, scale=scale if scaled else None)
        tuned = within(banded, TUNE).dropna(subset=["lo", "hi"])
        score = float(np.mean(backtest.interval_score(tuned["y"], tuned["lo"], tuned["hi"])))
        if best is None or score < best[0]:
            best = (score, gamma, window, scaled, banded)
    return best


# the band the fixed split used: one margin per horizon from the outcomes of
# the cal block, laid on every row
def static_band(frame):
    cal = frame[frame["block"] == "cal"]
    margin = spec.conformal_margin(cal["y"], cal["q10"], cal["q90"])
    lo, hi, _ = spec.apply_margin(frame["q10"], frame["q90"], margin)
    return frame.assign(lo=lo, hi=hi)


def scores(frame, span, name, horizon, band):
    rows = within(frame, span).dropna(subset=["lo", "hi"])
    y, q50 = rows["y"].to_numpy(dtype=float), rows["q50"].to_numpy(dtype=float)
    return {"model": name, "horizon": horizon, "span": span[0], "band": band, "n": int(len(rows)),
            "origins": int(rows["quarter"].nunique()),
            "mae_pct": float(np.mean(np.abs(spec.pct(y) - spec.pct(q50)))),
            "coverage": spec.coverage(y, rows["lo"], rows["hi"]),
            "width": spec.mean_width(rows["lo"], rows["hi"]),
            "interval_score": float(np.mean(backtest.interval_score(y, rows["lo"], rows["hi"])))}


# every model's record banded both ways, the chosen band settings, and the
# paired tests of the gru against every other model on RECORD and TEST
def evaluate(names=None, write=True, variant="latest"):
    panel = backtest.load_panel()
    scale = backtest.trailing_volatility(panel)
    frames = {name: load(name, variant) for name in names or MODELS}
    if all(n in frames for n in ENSEMBLE):
        frames["ensemble"] = ensemble(frames[ENSEMBLE[0]], frames[ENSEMBLE[1]])
    summary, bands, banded_all = [], [], {}
    for name, frame in frames.items():
        parts = []
        for h, group in frame.groupby("horizon", sort=True):
            group = group.reset_index(drop=True)
            tuned, gamma, window, scaled, banded = choose_band(group, scale)
            bands.append({"model": name, "horizon": int(h), "gamma": gamma, "window": window or 0,
                          "scaled": scaled, "tune_interval_score": tuned})
            for span in (RECORD, TEST):
                summary.append(scores(banded, span, name, int(h), "online"))
            # the static band is calibrated on 2018 to 2021 outcomes, so it is
            # only out of sample on TEST
            summary.append(scores(static_band(group), TEST, name, int(h), "static"))
            parts.append(banded)
        banded_all[name] = pd.concat(parts, ignore_index=True)
    paired = []
    for span in (RECORD, TEST):
        mine = within(frames["seqgru"], span).assign(block="test")
        for name, frame in frames.items():
            if name == "seqgru":
                continue
            rows = backtest.paired_test(mine, within(frame, span).assign(block="test"))
            paired.append(rows.assign(model="seqgru", against=name, span=span[0]))
    out = {"summary": pd.DataFrame(summary), "bands": pd.DataFrame(bands),
           "paired": pd.concat(paired, ignore_index=True)}
    if write:
        folder = spec.ML_ROOT / "results" / "walkforward" / variant
        folder.mkdir(parents=True, exist_ok=True)
        for key, table in out.items():
            table.to_csv(folder / f"{key}.csv", index=False)
    out["banded"] = banded_all
    return out


def main(names=None, variant="latest"):
    panel = backtest.load_panel()
    for name in names or MODELS:
        run_model(name, panel, variant=variant, log=lambda line: print(line, flush=True))
    evaluate(variant=variant)


if __name__ == "__main__":
    args = sys.argv[1:]
    variant = "vintage" if "--vintage" in args else "latest"
    main([a for a in args if not a.startswith("--")] or None, variant)

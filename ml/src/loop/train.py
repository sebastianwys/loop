# training and forecasting entry point. fits both networks on the fitting
# set with early stopping, calibrates the band on the cal block, scores the
# test block, then refits on everything realized for the shipped forecast.
# run with: .venv/bin/python -m loop.train

import copy
import random
import time

import numpy as np
import pandas as pd
import torch
from torch.utils.data import DataLoader, TensorDataset

from loop import backtest as shared
from loop import charts, nets, spec

# the validation set is the tail of the train block by outcome quarter
VAL_START = "2015Q1"
MODELS = {"windowmlp": nets.WindowMLP, "seqgru": nets.SeqGRU}
BATCH = 256
EVAL_BATCH = 4096
# a small step and firm weight decay, chosen on the validation loss alone:
# with the default 1e-3 and 1e-4 the validation loss climbed from the first
# epoch as the fitting era's own dynamics got learned
LR = 3e-4
WEIGHT_DECAY = 1e-3
MAX_EPOCHS = 60
PATIENCE = 5
SCORED = ("cal", "test")
FAN_START = "2015Q1"
PREDICTION_COLUMNS = ["cbsa_code", "quarter", "horizon", "block", "y", "q10", "q50", "q90", "lo", "hi"]


def qname(q):
    return f"q{int(round(100 * q))}"


# which part of the protocol a sample feeds, by origin and horizon: fit or
# val inside the train block, then cal, test, or None for the gaps
def split_of(origin, horizon):
    block = spec.block(origin, horizon)
    if block == "train":
        outcome = spec.to_period(origin) + horizon
        return "val" if outcome >= spec.to_period(VAL_START) else "fit"
    return block


def splits(origins):
    table = {o: [split_of(o, h) for h in spec.HORIZONS] for o in np.unique(origins)}
    return np.array([table[o] for o in origins], dtype=object)


def pick_device(name=None):
    if name is not None:
        return torch.device(name)
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def seed_everything(seed=spec.SEED):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def build_model(model_name, n_metros):
    return MODELS[model_name](n_metros)


# how much a batch counts toward an epoch's loss: its valid cells. the loss
# itself is a per-cell mean, so weighting by rows would let a ragged batch
# carry the weight of a full one and put the two curves on different scales
def loss_weight(y):
    return int((~torch.isnan(y)).sum())


def batched_loss(model, inputs, y, idx, device):
    model.eval()
    total, count = 0.0, 0
    with torch.no_grad():
        for start in range(0, len(idx), EVAL_BATCH):
            sel = idx[start : start + EVAL_BATCH]
            batch_y = y[sel].to(device)
            pred = model(*[x[sel].to(device) for x in inputs])
            weight = loss_weight(batch_y)
            total += float(nets.pinball_loss(pred, batch_y)) * weight
            count += weight
    return total / max(count, 1)


# one fit. y_fit and y_val are (windows, horizons) arrays with nan outside
# their split, so a window whose horizons straddle the two sets is used by
# both without either seeing the other's outcomes. with epochs given the loop
# runs that many epochs and skips early stopping
def train_one(model_name, windows, y_fit, y_val=None, device=None, max_epochs=MAX_EPOCHS, patience=PATIENCE, epochs=None, verbose=True):
    # step 1: device
    device = pick_device(device)

    # step 2: model, seeded first so a cpu run repeats exactly
    seed_everything()
    model = build_model(model_name, len(windows.metros))
    loc, scale, _ = nets.moments(y_fit)
    model.set_target_stats(loc, scale)
    model.to(device)

    # step 3: data to tensors. scaling statistics come from the fitting set
    # only, and the mini batches are shuffled within the fitting set only
    fit_mask = ~np.isnan(y_fit).all(axis=1)
    stats = nets.feature_stats(windows, fit_mask)
    seq, static, metro, _ = nets.to_tensors(windows, stats)
    inputs = (seq, static, metro)
    y_fit_t = torch.from_numpy(np.ascontiguousarray(y_fit, dtype=np.float32))
    fit_idx = torch.from_numpy(np.nonzero(fit_mask)[0])
    generator = torch.Generator().manual_seed(spec.SEED)
    batches = DataLoader(
        TensorDataset(seq[fit_idx], static[fit_idx], metro[fit_idx], y_fit_t[fit_idx]),
        batch_size=BATCH,
        shuffle=True,
        generator=generator,
    )
    val_idx = None
    if y_val is not None:
        y_val_t = torch.from_numpy(np.ascontiguousarray(y_val, dtype=np.float32))
        val_idx = torch.from_numpy(np.nonzero(~np.isnan(y_val).all(axis=1))[0])

    # step 4: loss and optimizer
    optimizer = torch.optim.Adam(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)

    # step 5: training loop, early stopping on the validation pinball loss
    history = []
    best_loss, best_state, best_epoch, waited = float("inf"), None, 0, 0
    limit = max_epochs if epochs is None else epochs
    for epoch in range(1, limit + 1):
        model.train()
        total, count = 0.0, 0
        for batch_seq, batch_static, batch_metro, batch_y in batches:
            batch_y = batch_y.to(device)
            pred = model(batch_seq.to(device), batch_static.to(device), batch_metro.to(device))
            loss = nets.pinball_loss(pred, batch_y)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            weight = loss_weight(batch_y)
            total += loss.item() * weight
            count += weight
        train_loss = total / max(count, 1)
        val_loss = float("nan") if val_idx is None else batched_loss(model, inputs, y_val_t, val_idx, device)
        history.append({"epoch": epoch, "train_loss": train_loss, "val_loss": val_loss})
        if verbose:
            print(f"{model_name} epoch {epoch:3d}  train {train_loss:.5f}  val {val_loss:.5f}", flush=True)
        if epochs is None:
            if val_loss < best_loss:
                best_loss, best_state, best_epoch, waited = val_loss, copy.deepcopy(model.state_dict()), epoch, 0
            else:
                waited += 1
                if waited >= patience:
                    break
    if best_state is not None:
        model.load_state_dict(best_state)
    return {"model": model, "stats": stats, "inputs": inputs, "history": pd.DataFrame(history), "device": device, "epochs": best_epoch or limit}


# step 6: predictions under no_grad, (rows, horizons, quantiles)
def predict(model, inputs, idx, device):
    model.eval()
    idx = torch.from_numpy(np.array(idx, dtype=np.int64))
    out = []
    with torch.no_grad():
        for start in range(0, len(idx), EVAL_BATCH):
            sel = idx[start : start + EVAL_BATCH]
            out.append(model(*[x[sel].to(device) for x in inputs]).cpu().numpy())
    if not out:
        return np.zeros((0, nets.N_HORIZONS, nets.N_QUANTILES), dtype=np.float32)
    return np.concatenate(out)


# one row per scored sample: a window, a horizon, its block and outcome, the
# three quantiles, and the band columns left for calibrate() to fill
def predictions_frame(windows, sample_splits, pred, idx):
    idx = np.asarray(idx)
    parts = []
    for j, h in enumerate(spec.HORIZONS):
        label = sample_splits[idx, j]
        keep = np.isin(label, SCORED) & ~np.isnan(windows.y[idx, j])
        sel = idx[keep]
        part = pd.DataFrame({
            "cbsa_code": windows.codes[sel],
            "quarter": windows.origins[sel],
            "horizon": h,
            "block": label[keep],
            "y": windows.y[sel, j].astype(float),
        })
        for k, q in enumerate(spec.QUANTILES):
            part[qname(q)] = pred[keep, j, k].astype(float)
        part["lo"] = np.nan
        part["hi"] = np.nan
        parts.append(part)
    frame = pd.concat(parts, ignore_index=True)
    return frame.sort_values(["cbsa_code", "quarter", "horizon"], ignore_index=True)[PREDICTION_COLUMNS]


# the conformal margin per horizon from one block's rows
def margins(predictions, block="cal"):
    rows = predictions[predictions["block"] == block]
    return {int(h): spec.conformal_margin(g["y"], g["q10"], g["q90"]) for h, g in rows.groupby("horizon")}


# minimal stand in for backtest.calibrate: widen the 0.1 to 0.9 band by the
# cal block's margin at every row of the same horizon
def calibrate(predictions):
    margin = margins(predictions, "cal")
    out = predictions.copy()
    m = out["horizon"].map(lambda h: margin.get(int(h), np.nan)).to_numpy(dtype=float)
    out["lo"], out["hi"], _ = spec.apply_margin(out["q10"], out["q90"], m)
    return out


def mae_pct(y, q50):
    return spec.mae(spec.pct(y), spec.pct(q50))


# minimal stand in for backtest.evaluate: one row per block and horizon
def evaluate(predictions):
    rows = []
    for block in ("train", "cal", "test"):
        for h in spec.HORIZONS:
            g = predictions[(predictions["block"] == block) & (predictions["horizon"] == h)]
            if g.empty:
                continue
            y = g["y"].to_numpy(dtype=float)
            row = {
                "horizon": h,
                "block": block,
                "n": int(np.isfinite(y).sum()),
                "mae": spec.mae(y, g["q50"]),
                "rmse": spec.rmse(y, g["q50"]),
                "relative_mae": spec.relative_mae(y, g["q50"]),
            }
            for q in spec.QUANTILES:
                row[f"pinball_{int(round(100 * q))}"] = spec.pinball(y, g[qname(q)], q)
            row["coverage_raw"] = spec.coverage(y, g["q10"], g["q90"])
            row["coverage"] = spec.coverage(y, g["lo"], g["hi"])
            row["width"] = spec.mean_width(g["lo"], g["hi"])
            row["mae_pct"] = mae_pct(y, g["q50"])
            rows.append(row)
    return pd.DataFrame(rows)


def best_epoch(history):
    val = history["val_loss"]
    if val.notna().any():
        return int(history.loc[val.idxmin(), "epoch"])
    return int(history["epoch"].max())


def backtest(panel, model_name, device=None, max_epochs=MAX_EPOCHS, patience=PATIENCE, verbose=True):
    windows = nets.build_windows(panel)
    sample_splits = splits(windows.origins)
    y_fit = np.where(sample_splits == "fit", windows.y, np.nan)
    y_val = np.where(sample_splits == "val", windows.y, np.nan)
    fitted = train_one(model_name, windows, y_fit, y_val, device, max_epochs, patience, verbose=verbose)
    scored = np.isin(sample_splits, SCORED) & ~np.isnan(windows.y)
    idx = np.nonzero(scored.any(axis=1))[0]
    pred = predict(fitted["model"], fitted["inputs"], idx, fitted["device"])
    # the shared framework calibrates and scores every model the same way
    fitted["predictions"], _ = shared.calibrate(predictions_frame(windows, sample_splits, pred, idx), model=model_name)
    fitted["windows"] = windows
    return fitted


def fit_and_score(panel, model_name, device=None, max_epochs=MAX_EPOCHS, patience=PATIENCE, verbose=True):
    fitted = backtest(panel, model_name, device, max_epochs, patience, verbose)
    return fitted["predictions"], fitted["history"]


def latest_origins(windows):
    table = pd.DataFrame({"metro": windows.metro, "t": windows.t})
    return table.groupby("metro")["t"].idxmax().to_numpy()


# the shipped forecast: a final model on every realized outcome, and a second
# model stopped at the calibration end whose margin on the test block is out
# of sample for the recent era and widens the final model's band
def forecast_models(panel, model_name, epochs=None, device=None, verbose=True):
    if epochs is None:
        _, history = fit_and_score(panel, model_name, device=device, verbose=verbose)
        epochs = best_epoch(history)
    windows = nets.build_windows(panel)
    sample_splits = splits(windows.origins)
    realized = ~np.isnan(windows.y)
    outcome_t = windows.t[:, None] + np.asarray(spec.HORIZONS)[None, :]
    through_cal = realized & (outcome_t <= windows.index_of(spec.CAL_END))

    final = train_one(model_name, windows, np.where(realized, windows.y, np.nan), None, device, epochs=epochs, verbose=verbose)
    second = train_one(model_name, windows, np.where(through_cal, windows.y, np.nan), None, device, epochs=epochs, verbose=verbose)

    test = (sample_splits == "test") & realized
    idx = np.nonzero(test.any(axis=1))[0]
    held_out = predictions_frame(windows, sample_splits, predict(second["model"], second["inputs"], idx, second["device"]), idx)
    margin = margins(held_out, "test")

    # a horizon with nothing realized on the test block has no conformal sample,
    # and a nan margin would ship a point forecast with no band at all
    bare = [h for h in spec.HORIZONS if not np.isfinite(margin.get(h, np.nan))]
    if bare:
        raise ValueError(
            f"no realized test outcome at horizon {bare}, so the band has "
            "nothing to calibrate on"
        )

    latest = latest_origins(windows)
    pred = predict(final["model"], final["inputs"], latest, final["device"])
    parts = []
    for j, h in enumerate(spec.HORIZONS):
        part = pd.DataFrame({"cbsa_code": windows.codes[latest], "origin": windows.origins[latest], "horizon": h})
        for k, q in enumerate(spec.QUANTILES):
            part[qname(q)] = pred[:, j, k].astype(float)
        lo, hi, crossed = spec.apply_margin(part["q10"], part["q90"], margin[h])
        # the backtest collapses a crossed band and counts it, because an
        # over-wide baseline still has to be scored. the shipped forecast is
        # the published artifact, and a band the calibration inverted is not
        # one a reader can act on, so it stops here instead
        if crossed.any():
            raise ValueError(
                f"the margin at horizon {h} inverts the band on {int(crossed.sum())} "
                "metros, so the calibration is not usable for a shipped forecast"
            )
        part["lo"], part["hi"] = lo, hi
        parts.append(part)
    frame = pd.concat(parts, ignore_index=True).sort_values(["cbsa_code", "horizon"], ignore_index=True)
    for col in ("q50", "lo", "hi"):
        frame[f"{col}_pct"] = spec.pct(frame[col])
    frame["model"] = model_name
    return frame, final, second, epochs


def forecast(panel, model_name, epochs=None, device=None, verbose=True):
    frame, _, _, _ = forecast_models(panel, model_name, epochs, device, verbose)
    return frame


# a panel with the contract's columns for tests and for a run without the
# real file: a national factor plus local momentum drive prices, mortgage
# rates lean on growth, and the covariates start late the way the sources do
def ar1(rng, n, phi, sigma):
    out = np.empty(n)
    value = 0.0
    for i in range(n):
        value = phi * value + rng.normal(0.0, sigma)
        out[i] = value
    return out


def shifted(values, steps):
    out = np.full_like(values, np.nan)
    out[steps:] = values[:-steps]
    return out


# log change over a number of quarters inside each metro, on a frame that is
# already sorted by metro and quarter
def safe_log_diff(frame, column, steps):
    values = np.log(frame[column].where(frame[column] > 0))
    return values - values.groupby(frame["cbsa_code"]).shift(steps)


def synthetic_panel(n_metros=12, start="1995Q1", end="2026Q2", seed=spec.SEED):
    rng = np.random.default_rng(seed)
    periods = pd.period_range(start, end, freq="Q")
    n = len(periods)
    quarters = [str(p) for p in periods]
    years = periods.year.to_numpy()
    dates = [spec.quarter_end(q) for q in quarters]
    from_2014 = years >= 2014
    from_2016q3 = periods >= spec.to_period("2016Q3")
    national = 0.008 + ar1(rng, n, 0.8, 0.004)
    mortgage = np.clip(6.0 + ar1(rng, n, 0.95, 0.3), 2.5, 12.0)
    from_1991 = years >= 1991

    # one number per quarter for every metro. no cross section, which is the
    # whole reason these are carried and not fitted
    short_rate = np.clip(mortgage - 2.0 + ar1(rng, n, 0.9, 0.2), 0.0, 10.0)
    macro = {
        "cpi_yoy": 0.025 + ar1(rng, n, 0.9, 0.004),
        "treasury_10y": mortgage - 1.6,
        "term_spread": mortgage - 1.6 - short_rate,
        "natl_unemp": np.clip(5.5 + ar1(rng, n, 0.95, 0.3), 2.0, 12.0),
        "quarter_sin": np.sin(2.0 * np.pi * periods.quarter.to_numpy() / 4.0),
        "quarter_cos": np.cos(2.0 * np.pi * periods.quarter.to_numpy() / 4.0),
    }
    showcase = list(spec.SHOWCASE)
    codes = showcase[:n_metros] + [str(20000 + 7 * i) for i in range(max(0, n_metros - len(showcase)))]

    def yearly(loc, scale):
        draws = {year: rng.normal(loc, scale) for year in np.unique(years)}
        return np.array([draws[year] for year in years])

    frames = []
    for m, code in enumerate(codes):
        first = int(n * 0.7) if m % 5 == 4 else 0
        drift = rng.normal(0.0, 0.003)
        beta = rng.uniform(0.6, 1.4)
        local = ar1(rng, n, 0.6, 0.006)
        qoq = beta * national + drift + local - 0.0015 * (mortgage - 6.0)
        log_hpi = np.log(rng.uniform(80.0, 250.0)) + np.cumsum(qoq)
        log_hpi[:first] = np.nan
        log_zhvi = np.where(years >= 2000, np.log(1500.0) + log_hpi + ar1(rng, n, 0.9, 0.01), np.nan)
        log_zori = np.where(years >= 2015, np.log(1200.0) + 0.5 * (log_hpi - np.nanmean(log_hpi)) + ar1(rng, n, 0.9, 0.01), np.nan)
        name = spec.SHOWCASE.get(code, f"Metro {code}")
        division = "division" in name
        frames.append(pd.DataFrame({
            "cbsa_code": code,
            "quarter": quarters,
            "name": name,
            "level": "division" if division else "msa",
            "parent_cbsa": code[:-1] + "0" if division else None,
            "date": dates,
            "hpi": np.exp(log_hpi),
            "log_hpi": log_hpi,
            "unemp": np.where(from_2014, 5.0 + ar1(rng, n, 0.9, 0.3) - 40.0 * local, np.nan),
            "mortgage": mortgage,
            "zhvi": np.exp(log_zhvi),
            "zori": np.exp(log_zori),
            "hpi_qoq": log_hpi - shifted(log_hpi, 1),
            "hpi_yoy": log_hpi - shifted(log_hpi, 4),
            "zhvi_yoy": log_zhvi - shifted(log_zhvi, 4),
            "zori_yoy": log_zori - shifted(log_zori, 4),
            "permits_per_1000": np.where(from_2014, yearly(3.0 + 200.0 * drift, 0.8), np.nan),
            "pop_growth": np.where(from_2014, yearly(0.005 + 0.5 * drift, 0.004), np.nan),
            "domestic_migration_rate": np.where(from_2014, yearly(0.002 + 0.4 * drift, 0.004), np.nan),
            "income_growth": np.where(from_2014, yearly(0.03 + beta * 0.005, 0.01), np.nan),
            "listing_price_yoy": np.where(from_2016q3, 4.0 * (log_hpi - shifted(log_hpi, 4)) + ar1(rng, n, 0.5, 0.02), np.nan),
            "inventory_yoy": np.where(from_2016q3, ar1(rng, n, 0.7, 0.05) - 2.0 * local, np.nan),
            # fhfa's second estimate of the same quarter, published from 1991,
            # and the standard error it carries. a later metro is smaller here,
            # so its index is the looser measurement
            "hpi_exp": np.where(from_1991, np.exp(log_hpi + ar1(rng, n, 0.5, 0.004)), np.nan),
            "hpi_rstderr": np.where(from_1991, np.abs(0.3 + 0.2 * m + ar1(rng, n, 0.6, 0.05)), np.nan),
            **macro,
        }))
    panel = pd.concat(frames, ignore_index=True)
    panel["hpi_exp_yoy"] = safe_log_diff(panel, "hpi_exp", 4)
    panel["hpi_rstderr_rel"] = 100.0 * panel["hpi_rstderr"] / panel["hpi_exp"].where(panel["hpi_exp"] > 0)
    panel["hpi_yoy_rel"] = panel["hpi_yoy"] - panel.groupby("quarter")["hpi_yoy"].transform("median")

    # a column added to the contract and not here dies on a bare KeyError in
    # whichever test happened to run first. name the column instead
    absent = [c for c in spec.PANEL_COLUMNS if c not in panel.columns]
    if absent:
        raise ValueError(f"synthetic_panel does not build {absent}, which the panel contract requires")
    return panel[spec.PANEL_COLUMNS]


# ml/data/panel.parquet is not tracked, so a clone that has not built one has
# no panel at all. a made up panel must be asked for out loud: it used to be
# the silent fallback and its results went into the tracked csvs unmarked
def load_panel(panel=None, allow_synthetic=False):
    if panel is not None:
        return panel, "given"
    if spec.PANEL_PATH.exists():
        return pd.read_parquet(spec.PANEL_PATH), "panel"
    if not allow_synthetic:
        raise FileNotFoundError(
            f"no panel at {spec.PANEL_PATH}. build it with panel.build(), pass one "
            "in, or ask for a synthetic panel with allow_synthetic=True"
        )
    return synthetic_panel(n_metros=120, start="1980Q1"), "synthetic"


def last_quarter(panel):
    return str(pd.PeriodIndex(panel["quarter"], freq="Q").max())


def summary_line(model_name, summary, block):
    rows = summary[summary["block"] == block].sort_values("horizon")
    if rows.empty:
        return f"{model_name} {block}: no rows"
    n = int(rows["n"].sum())
    err = " ".join(f"h{int(h)} {v:.2f}" for h, v in zip(rows["horizon"], rows["mae_pct"]))
    cov = " ".join(f"h{int(h)} {v:.2f}" for h, v in zip(rows["horizon"], rows["coverage"]))
    return f"{model_name} {block}: n {n}  mae_pct {err}  coverage {cov}"


# selection reads the cal block. the test block is scored once, to report
def cal_mae_pct(summary, horizon):
    rows = summary[(summary["block"] == "cal") & (summary["horizon"] == horizon)]
    return float(rows["mae_pct"].iloc[0]) if len(rows) else float("inf")


# figures. every one names what is plotted, the block and the data date
def note(source, last):
    tag = " (synthetic panel)" if source == "synthetic" else ""
    return f"data through {last}{tag}"


def plot_training_curves(histories, epochs, when):
    fig, axes = charts.figure("Training curves", f"pinball loss per epoch on the fitting set (outcomes through {spec.shift_quarter(VAL_START, -1)}) and the validation set ({VAL_START} to {spec.TRAIN_END}), {when}", size=(10, 4.5), rows=1, cols=2)
    fig.subplots_adjust(top=0.78, wspace=0.25)
    for k, (ax, name) in enumerate(zip(axes, histories)):
        h = histories[name]
        ax.plot(h["epoch"], h["train_loss"], color=charts.SERIES[0], label="fitting set")
        ax.plot(h["epoch"], h["val_loss"], color=charts.SERIES[1], label="validation")
        stop = epochs[name]
        ax.axvline(stop, color=charts.MUTED, linestyle="--", linewidth=0.8)
        top = np.nanmax(np.r_[h["train_loss"], h["val_loss"]])
        side = "right" if stop > 0.6 * h["epoch"].max() else "left"
        ax.annotate(f"stopped at epoch {stop}", (stop, top), xytext=(-5 if side == "right" else 5, 0), textcoords="offset points", ha=side, va="top", fontsize=8, color=charts.INK2)
        ax.set_title(name)
        ax.set_xlabel("epoch")
        if k == 0:
            ax.set_ylabel("pinball loss, log growth units")
            ax.legend(loc="upper right", bbox_to_anchor=(1.0, 0.85))
    return charts.save(fig, "09_training_curves")


# the raw quantiles belong on a diagonal: each one claims its own nominal
# level. the conformal edges do not. a symmetric margin is fitted for the band
# as a whole to reach 1 - alpha, so drawing its edges at 0.1 and 0.9 measured
# them against levels they never claimed and doubled the apparent miss. the
# band's own number, its coverage, goes in the title instead
def plot_calibration(predictions, model_name, when, return_figure=False):
    test = predictions[predictions["block"] == "test"]
    fig, axes = charts.figure("Quantile calibration", f"share of test block outcomes below each predicted quantile, {model_name}, {when}. the conformal band is one interval, so its coverage is reported rather than plotted", size=(8, 7.5), rows=2, cols=2)
    fig.subplots_adjust(top=0.86, hspace=0.4, wspace=0.3)
    nominal = list(spec.QUANTILES)
    for k, (ax, h) in enumerate(zip(axes.flat, spec.HORIZONS)):
        g = test[test["horizon"] == h]
        y = g["y"].to_numpy()
        raw = [np.mean(y <= g[qname(q)].to_numpy()) for q in nominal]
        covered = spec.coverage(g["y"], g["lo"], g["hi"])
        ax.plot([0, 1], [0, 1], color=charts.AXIS, linewidth=0.8)
        ax.plot(nominal, raw, marker="o", markersize=4, color=charts.SERIES[0], label="raw quantiles")
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1)
        ax.set_xticks(nominal)
        ax.set_title(f"{h} quarter{'s' if h > 1 else ''} ahead, n {len(g)}, band coverage {covered:.2f} of {1 - spec.ALPHA:.2f}")
        ax.set_xlabel("nominal quantile")
        if k % 2 == 0:
            ax.set_ylabel("share of outcomes below")
        if k == 0:
            ax.legend(loc="upper left")
    path = charts.save(fig, "10_quantile_calibration")
    return fig if return_figure else path


def plot_fans(panel, forecasts, model_name, when):
    import matplotlib.dates as mdates

    have = set(forecasts["cbsa_code"])
    codes = [c for c in spec.SHOWCASE if c in have][:8]
    codes += [c for c in forecasts["cbsa_code"].unique() if c not in codes][: 8 - len(codes)]
    names = panel.drop_duplicates("cbsa_code").set_index("cbsa_code")["name"]
    origin = forecasts["origin"].max()
    fig, axes = charts.figure("Forecast fans", f"house price index since {FAN_START} and the median path with a 90 percent band, origin {origin}, {model_name}, {when}", size=(14, 7), rows=2, cols=4)
    fig.subplots_adjust(top=0.85, hspace=0.45, wspace=0.25)
    for k, (ax, code) in enumerate(zip(axes.flat, codes)):
        rows = forecasts[forecasts["cbsa_code"] == code].sort_values("horizon")
        start = rows["origin"].iloc[0]
        history = panel[(panel["cbsa_code"] == code) & (panel["quarter"] >= FAN_START) & (panel["quarter"] <= start)].sort_values("quarter")
        level = float(np.exp(history.loc[history["quarter"] == start, "log_hpi"].iloc[0]))
        ax.plot([spec.quarter_end(q) for q in history["quarter"]], np.exp(history["log_hpi"]), color=charts.INK2, linewidth=1.2)
        x = [spec.quarter_end(start)] + [spec.quarter_end(spec.shift_quarter(start, int(h))) for h in rows["horizon"]]
        ax.fill_between(x, [level] + list(level * np.exp(rows["lo"])), [level] + list(level * np.exp(rows["hi"])), color=charts.BAND, linewidth=0)
        ax.plot(x, [level] + list(level * np.exp(rows["q50"])), color=charts.SERIES[0], marker="o", markersize=3)
        far = rows.iloc[-1]
        ax.text(0.03, 0.93, f"{int(far['horizon'])}q median {far['q50_pct']:+.1f}%, band {far['lo_pct']:+.1f}% to {far['hi_pct']:+.1f}%", transform=ax.transAxes, fontsize=7, color=charts.INK2, va="top")
        ax.set_title(spec.SHOWCASE.get(code, names.get(code, code)))
        ax.xaxis.set_major_locator(mdates.YearLocator(4))
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
        ax.margins(y=0.2)
        if k % 4 == 0:
            ax.set_ylabel("index level")
    for ax in list(axes.flat)[len(codes):]:
        ax.set_visible(False)
    return charts.save(fig, "11_forecast_fans")


# push labels apart from the bottom up so they never overlap
def spread(values, gap):
    out = np.array(values, dtype=float)
    order = np.argsort(out)
    for a, b in zip(order[:-1], order[1:]):
        if out[b] - out[a] < gap:
            out[b] = out[a] + gap
    return out


def plot_comparison(summaries, baselines, when):
    fig, ax = charts.figure("Model comparison", f"mean absolute error of the median forecast on the test block, percentage points of growth, {when}", size=(9, 5.5))
    fig.subplots_adjust(top=0.84, right=0.82)
    lines = []
    for name, summary in summaries.items():
        rows = summary[summary["block"] == "test"].sort_values("horizon")
        lines.append((name, rows["horizon"].to_numpy(), rows["mae_pct"].to_numpy()))
    if baselines is not None:
        rows = baselines[baselines["block"] == "test"]
        for name in rows["model"].drop_duplicates():
            g = rows[rows["model"] == name].sort_values("horizon")
            lines.append((str(name), g["horizon"].to_numpy(), g["mae_pct"].to_numpy()))
    lines = lines[: len(charts.SERIES)]
    ends = [line[2][-1] for line in lines]
    top = max(np.nanmax(line[2]) for line in lines)
    placed = spread(ends, 0.045 * top)
    for (name, x, y), color, at in zip(lines, charts.SERIES, placed):
        ax.plot(x, y, color=color, marker="o", markersize=4)
        ax.annotate(name, (x[-1], at), xytext=(8, 0), textcoords="offset points", va="center", fontsize=8, color=charts.INK2)
    ax.set_ylim(0, max(top * 1.1, placed.max() + 0.05 * top))
    ax.set_xticks(list(spec.HORIZONS))
    ax.set_xlabel("horizon, quarters ahead")
    ax.set_ylabel("mean absolute error, percentage points")
    ax.set_xlim(spec.HORIZONS[0] - 0.3, spec.HORIZONS[-1] + 0.3)
    return charts.save(fig, "12_model_comparison")


def plot_distribution(forecasts, model_name, when):
    rows = forecasts[forecasts["horizon"] == 4]
    values = rows["q50_pct"].to_numpy(dtype=float)
    origin = rows["origin"].max()
    fig, ax = charts.figure("Forecast distribution", f"median four quarter forecast across {len(values)} metros, {model_name}, origin {origin}, {when}", size=(9, 5.5))
    fig.subplots_adjust(top=0.84)
    ax.hist(values, bins=30, color=charts.SERIES[0], edgecolor=charts.SURFACE, linewidth=0.5)
    marks = np.percentile(values, [10, 50, 90])
    for (label, value), height in zip(zip(("10th percentile", "median", "90th percentile"), marks), (0.96, 0.87, 0.78)):
        ax.axvline(value, color=charts.INK2, linewidth=0.8)
        ax.text(value, height, f" {label} {value:+.1f}%", transform=ax.get_xaxis_transform(), fontsize=8, color=charts.INK2, va="top")
    charts.pct_axis(ax, "x", 0)
    ax.set_xlabel("median forecast, four quarters ahead")
    ax.set_ylabel("metros")
    return charts.save(fig, "13_forecast_distribution")


def run(panel=None, device=None, max_epochs=MAX_EPOCHS, patience=PATIENCE, verbose=True, allow_synthetic=False):
    panel, source = load_panel(panel, allow_synthetic)
    last = last_quarter(panel)
    when = note(source, last)
    for folder in (spec.ML_ROOT / "data", spec.BACKTEST_DIR, spec.FORECAST_DIR, spec.MODELS_DIR):
        folder.mkdir(parents=True, exist_ok=True)

    results = {}
    for name in MODELS:
        started = time.time()
        fitted = backtest(panel, name, device, max_epochs, patience, verbose)
        summary = shared.evaluate(fitted["predictions"])
        fitted["summary"] = summary
        fitted["seconds"] = time.time() - started
        fitted["predictions"].to_parquet(spec.ML_ROOT / "data" / f"predictions_{name}.parquet", index=False)
        summary.to_csv(spec.BACKTEST_DIR / f"{name}.csv", index=False)
        fitted["history"].to_csv(spec.BACKTEST_DIR / f"{name}_history.csv", index=False)
        torch.save({"model": name, "state": fitted["model"].state_dict(), "stats": fitted["stats"], "metros": fitted["windows"].metros, "epochs": fitted["epochs"]}, spec.MODELS_DIR / f"{name}_backtest.pt")
        if verbose:
            for block in SCORED:
                print(summary_line(name, summary, block), flush=True)
            print(f"{name}: stopped at epoch {fitted['epochs']}, {fitted['seconds']:.0f} s", flush=True)
        results[name] = fitted

    shipped = min(MODELS, key=lambda n: cal_mae_pct(results[n]["summary"], 4))
    forecasts = {}
    for name in MODELS:
        started = time.time()
        frame, final, _, _ = forecast_models(panel, name, results[name]["epochs"], device, verbose)
        frame.to_csv(spec.FORECAST_DIR / f"forecasts_{name}.csv", index=False)
        torch.save({"model": name, "state": final["model"].state_dict(), "stats": final["stats"], "metros": results[name]["windows"].metros, "epochs": results[name]["epochs"]}, spec.MODELS_DIR / f"{name}.pt")
        forecasts[name] = frame
        results[name]["forecast_seconds"] = time.time() - started
    forecasts[shipped].to_csv(spec.FORECAST_DIR / "forecasts.csv", index=False)
    if verbose:
        print(f"shipped {shipped} on cal mae_pct at four quarters", flush=True)

    plot_training_curves({n: results[n]["history"] for n in MODELS}, {n: results[n]["epochs"] for n in MODELS}, when)
    plot_calibration(results[shipped]["predictions"], shipped, when)
    plot_fans(panel, forecasts[shipped], shipped, when)
    baseline_path = spec.BACKTEST_DIR / "baselines.csv"
    baselines = pd.read_csv(baseline_path, dtype={"model": str}) if baseline_path.exists() else None
    plot_comparison({n: results[n]["summary"] for n in MODELS}, baselines, when)
    plot_distribution(forecasts[shipped], shipped, when)
    return {"shipped": shipped, "results": results, "forecasts": forecasts, "source": source}


if __name__ == "__main__":
    run()

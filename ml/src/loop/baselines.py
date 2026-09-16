# classical baselines for the house price backtest. each model reads the
# shared dataset, fits on the train block only and reports q10, q50, q90 for
# every sample. calibrate() then widens the band on the cal block and
# evaluate() scores every block. run with python -m loop.baselines

import time

import numpy as np
import pandas as pd
from matplotlib.patheffects import withStroke
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

from loop import backtest, charts, spec

ALPHAS = np.logspace(-2, 6, 17)
RIDGE_ALPHA = {}
GBM = dict(
    max_iter=200, learning_rate=0.05, max_depth=4, max_leaf_nodes=15, min_samples_leaf=200,
    l2_regularization=10.0, early_stopping=False, random_state=spec.SEED,
)


def _predictions(frame, q10, q50, q90, name):
    out = frame[backtest.SAMPLE_COLUMNS].copy()
    out["q10"], out["q50"], out["q90"] = q10, q50, q90
    out = backtest.sort_quantiles(out)
    out["lo"], out["hi"] = out["q10"], out["q90"]
    out["model"] = name
    return out[backtest.PREDICTION_COLUMNS]


# the band around a point rule is the 10th and 90th percentile of its train
# residuals, so the interval says how wrong the rule was in the past
def _band(residuals):
    return np.nanquantile(residuals, [0.1, 0.9])


def _per_horizon(data, fit):
    parts = []
    for h, group in data.groupby("horizon", sort=True):
        parts.append(fit(int(h), group.reset_index(drop=True)))
    return pd.concat(parts, ignore_index=True)


def no_change(data):
    def fit(h, g):
        train = g[g["block"] == "train"]
        lo, hi = np.quantile(train["y"], [0.1, 0.9])
        n = len(g)
        return _predictions(g, np.full(n, lo), np.zeros(n), np.full(n, hi), "no_change")
    return _per_horizon(data, fit)


# a point rule from one feature. where the feature is null the rule falls
# back to no change, and the band comes from residuals where it existed
def _rule(data, name, signal):
    def fit(h, g):
        q50 = signal(h, g)
        train = (g["block"] == "train").to_numpy()
        lo, hi = _band(g["y"].to_numpy(dtype=float)[train] - q50[train])
        q50 = np.where(np.isnan(q50), 0.0, q50)
        return _predictions(g, q50 + lo, q50, q50 + hi, name)
    return _per_horizon(data, fit)


def momentum(data):
    return _rule(data, "momentum", lambda h, g: g["hpi_yoy"].to_numpy(dtype=float) * h / 4.0)


def metro_mean(data):
    return _rule(data, "metro_mean", lambda h, g: g["qoq_mean"].to_numpy(dtype=float) * h)


# nulls become the train median plus a missing flag per feature, then every
# column is standardized on the train block
def _matrix(frame, prep=None):
    X = frame[backtest.FEATURE_COLUMNS].astype(float)
    if prep is None:
        prep = {"median": X.median().fillna(0.0)}
    filled = X.fillna(prep["median"])
    flags = X.isna().astype(float).add_suffix("_missing")
    M = pd.concat([filled, flags], axis=1).to_numpy(dtype=float)
    if "scaler" not in prep:
        prep["scaler"] = StandardScaler().fit(M)
    return prep["scaler"].transform(M), prep


# alpha by a time ordered split inside the train block: fit on origins whose
# outcome lands by the cut quarter, score on origins after the cut, so the
# choice never sees an outcome the fit could not have seen
def _pick_alpha(train, h):
    quarters = np.sort(train["quarter"].unique())
    cut = quarters[int(0.8 * len(quarters))]
    fit = train[train["quarter"] <= spec.shift_quarter(cut, -h)]
    check = train[train["quarter"] > cut]
    X_fit, prep = _matrix(fit)
    X_check, _ = _matrix(check, prep)
    scores = []
    for alpha in ALPHAS:
        model = Ridge(alpha=alpha).fit(X_fit, fit["y"])
        scores.append(spec.mae(check["y"], model.predict(X_check)))
    return float(ALPHAS[int(np.argmin(scores))])


def ridge(data):
    # main() prints this dict as the alphas of the run it just made, so a
    # horizon left behind by an earlier call must not survive into it
    RIDGE_ALPHA.clear()

    def fit(h, g):
        train = g[g["block"] == "train"]
        alpha = _pick_alpha(train, h)
        RIDGE_ALPHA[h] = alpha
        X_train, prep = _matrix(train)
        model = Ridge(alpha=alpha).fit(X_train, train["y"])
        X_all, _ = _matrix(g, prep)
        q50 = model.predict(X_all)
        lo, hi = _band(train["y"].to_numpy(dtype=float) - model.predict(X_train))
        return _predictions(g, q50 + lo, q50, q50 + hi, "ridge")
    return _per_horizon(data, fit)


# three quantile fits per horizon with a fixed iteration count, so the run is
# the same every time. the trees take nulls as they come, except a feature
# with no train value at all, which the binner cannot place
def gbm(data):
    def fit(h, g):
        train = g[g["block"] == "train"]
        usable = [c for c in backtest.FEATURE_COLUMNS if train[c].notna().any()]
        X_train = train[usable].to_numpy(dtype=float)
        X_all = g[usable].to_numpy(dtype=float)
        q = {}
        for level in spec.QUANTILES:
            model = HistGradientBoostingRegressor(loss="quantile", quantile=level, **GBM)
            q[level] = model.fit(X_train, train["y"]).predict(X_all)
        return _predictions(g, q[0.1], q[0.5], q[0.9], "gbm")
    return _per_horizon(data, fit)


MODELS = {"no_change": no_change, "momentum": momentum, "metro_mean": metro_mean, "ridge": ridge, "gbm": gbm}


def run_model(name, data):
    predictions, margins = backtest.calibrate(MODELS[name](data))
    return predictions, backtest.evaluate(predictions), margins


def run_all(panel, figures=True, log=print):
    started = time.perf_counter()
    data = backtest.dataset(panel)
    summaries, margins, predictions = [], [], {}
    for name in MODELS:
        preds, summary, margin = run_model(name, data)
        backtest.write_summary(summary, name)
        backtest.write_predictions(preds, name)
        summaries.append(summary)
        margins.append(margin)
        predictions[name] = preds
        log(f"{name} done at {time.perf_counter() - started:.0f}s")
    combined = pd.concat(summaries, ignore_index=True)
    margins = pd.concat(margins, ignore_index=True)
    backtest.write_summary(combined, "baselines")
    backtest.write_summary(margins, "baselines_margins")
    if figures:
        make_figures(combined, predictions["gbm"], panel["quarter"].max())
    return combined, margins


# charts. models keep their color by position in MODELS, later models take
# the next slots in order of appearance
def _color(name, models):
    known = list(MODELS) + [m for m in models if m not in MODELS]
    return charts.SERIES[known.index(name) % len(charts.SERIES)]


def _label(name, sep=" "):
    return name.replace("_", sep)


def _x(quarter):
    p = spec.to_period(quarter)
    return p.year + (p.quarter - 1) / 4.0


# push label positions apart until neighbours sit at least gap apart
def _spread(values, gap):
    out = np.array(values, dtype=float)
    order = np.argsort(out)
    for _ in range(100):
        moved = False
        for a, b in zip(order[:-1], order[1:]):
            short = gap - (out[b] - out[a])
            if short > 1e-9:
                out[a] -= short / 2
                out[b] += short / 2
                moved = True
        if not moved:
            break
    return out


def _covers(label, renderer, dots):
    box = label.get_window_extent(renderer)
    return any(box.contains(px, py) for px, py in dots)


# text beside each point, nudged apart vertically, flipped to the left when
# it would sit on another labelled point, with a thin leader where the text
# had to leave its point. call after the axis limits are final
def _label_points(ax, points, gap, dx=6):
    if not points:
        return
    ys = _spread([p[1] for p in points], gap)
    halo = [withStroke(linewidth=2.5, foreground=charts.SURFACE)]
    renderer = ax.figure.canvas.get_renderer()
    dots = ax.transData.transform([[p[0], p[1]] for p in points])
    for i, ((x, y, text), y_text) in enumerate(zip(points, ys)):
        label = ax.annotate(
            text, (x, y_text), xytext=(dx, 0), textcoords="offset points",
            va="center", fontsize=8, color=charts.INK2, path_effects=halo, zorder=6,
        )
        others = np.delete(dots, i, axis=0)
        if _covers(label, renderer, others):
            label.set_ha("right")
            label.xyann = (-dx, 0)
            if _covers(label, renderer, others):
                label.set_ha("left")
                label.xyann = (dx, 0)
        if abs(y_text - y) > 0.1 * gap:
            ax.plot([x, x], [y, y_text], color=charts.INK2, linewidth=0.5, zorder=4)


def design_chart(data_date="2026Q2", start="2005Q1"):
    fig, ax = charts.figure(
        "How the backtest is split",
        f"forecast origins by horizon and block; a line from the last origin of a block ends where its outcome lands; panel through {data_date}",
        size=(10, 4.6),
    )
    colors = dict(zip(backtest.BLOCKS, charts.SERIES))
    first = {"train": start, "cal": spec.CAL_START, "test": spec.TEST_START}
    last = {"train": spec.TRAIN_END, "cal": spec.CAL_END, "test": data_date}
    top = len(spec.HORIZONS)
    for block in backtest.BLOCKS:
        x0, x1 = _x(first[block]), _x(last[block]) + 0.25
        ax.fill_between([x0, x1], top - 0.24, top + 0.24, color=colors[block], alpha=0.3, linewidth=0)
        note = {"train": f"train: outcomes to {last[block]}", "cal": f"cal: to {last[block]}", "test": f"test: outcomes from {first[block]}"}[block]
        ax.text((x0 + x1) / 2, top, note, ha="center", va="center", fontsize=8, color=charts.INK2)
    quarters = [str(p) for p in pd.period_range(start, data_date, freq="Q")]
    end = spec.to_period(data_date)
    for row, h in enumerate(spec.HORIZONS):
        y = top - 1 - row
        latest = {}
        for q in quarters:
            b = spec.block(q, h)
            if b is None or spec.to_period(q) + h > end:
                continue
            ax.vlines(_x(q), y - 0.16, y + 0.16, color=colors[b], linewidth=0.9)
            latest[b] = q
        for b, q in latest.items():
            outcome = spec.shift_quarter(q, h)
            ax.plot([_x(q), _x(outcome)], [y + 0.3, y + 0.3], color=colors[b], linewidth=0.8)
            ax.plot([_x(outcome)], [y + 0.3], marker="o", markersize=3, color=colors[b])
    gap_row = top - len(spec.HORIZONS)
    ax.annotate(
        "no origin here: the outcome would land in the next block",
        (_x("2017Q1"), gap_row), xytext=(_x("2008Q3"), gap_row - 0.75),
        fontsize=8, color=charts.INK2, va="center",
        arrowprops=dict(arrowstyle="-", color=charts.AXIS, linewidth=0.6),
    )
    ax.set_yticks([top] + [top - 1 - i for i in range(len(spec.HORIZONS))])
    ax.set_yticklabels(["blocks"] + [f"{h} quarter{'s' if h > 1 else ''} ahead" for h in spec.HORIZONS])
    ax.tick_params(axis="y", length=0)
    years = list(range(spec.to_period(start).year, end.year + 1, 3))
    ax.set_xticks(years)
    ax.set_xticklabels([str(v) for v in years])
    ax.set_xlim(_x(start) - 0.3, _x(data_date) + 0.6)
    ax.set_ylim(gap_row - 1.2, top + 0.9)
    ax.grid(False)
    ax.spines["left"].set_visible(False)
    return charts.save(fig, "05_backtest_design")


def errors_chart(summary, data_date):
    test = summary[summary["block"] == "test"]
    models = list(dict.fromkeys(test["model"]))
    fig, ax = charts.figure(
        "Forecast error on the test block by horizon",
        f"mean absolute error of the median forecast in percentage points; test block, outcomes from {spec.TEST_START}; panel through {data_date}",
    )
    positions = np.arange(len(spec.HORIZONS))
    points = []
    for name in models:
        rows = test[test["model"] == name].set_index("horizon").reindex(list(spec.HORIZONS))
        values = rows["mae_pct"].to_numpy(dtype=float)
        ax.plot(positions, values, color=_color(name, models), marker="o", markersize=3)
        points.append((positions[-1], values[-1], _label(name)))
    top = float(np.nanmax(test["mae_pct"])) * 1.1
    ax.set_xticks(positions)
    ax.set_xticklabels([str(h) for h in spec.HORIZONS])
    ax.set_xlabel("quarters ahead")
    ax.set_ylabel("mean absolute error, percentage points")
    ax.set_xlim(-0.2, len(positions) - 1 + 0.8)
    ax.set_ylim(0, top)
    _label_points(ax, points, gap=0.045 * top)
    return charts.save(fig, "06_baseline_errors")


def calibration_chart(summary, data_date):
    test = summary[summary["block"] == "test"]
    models = list(dict.fromkeys(test["model"]))
    fig, axes = charts.figure(
        "Interval coverage before and after conformal calibration",
        f"share of test outcomes inside the 10 to 90 band, target 0.9; test block, outcomes from {spec.TEST_START}; panel through {data_date}",
        size=(10, 6.5), rows=2, cols=2, sharey=True,
    )
    x = np.arange(len(models))
    for ax, h in zip(axes.ravel(), spec.HORIZONS):
        rows = test[test["horizon"] == h].set_index("model").reindex(models)
        ax.bar(x - 0.18, rows["coverage_raw"], width=0.34, color=charts.BAND, label="before, q10 to q90")
        ax.bar(x + 0.18, rows["coverage"], width=0.34, color=charts.SERIES[0], label="after, lo to hi")
        for xi, value in zip(x + 0.18, rows["coverage"]):
            if np.isfinite(value) and value > 0.15:
                ax.text(xi, value - 0.02, f"{value:.2f}", ha="center", va="top", fontsize=7, color=charts.SURFACE)
        ax.axhline(1 - spec.ALPHA, color=charts.INK2, linewidth=0.8, linestyle="--")
        ax.set_title(f"{h} quarter{'s' if h > 1 else ''} ahead")
        ax.set_xticks(x)
        ax.set_xticklabels([_label(m, "\n") for m in models])
        ax.set_ylim(0, 1.05)
        ax.set_yticks([0, 0.25, 0.5, 0.75, 0.9, 1.0])
    handles, labels = axes.ravel()[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper right", bbox_to_anchor=(0.99, 0.95), ncol=2)
    fig.subplots_adjust(top=0.85, hspace=0.4)
    return charts.save(fig, "07_calibration")


def actual_vs_predicted_chart(predictions, data_date, horizon=4):
    rows = predictions[(predictions["horizon"] == horizon) & (predictions["block"] == "test")]
    name = rows["model"].iloc[0] if len(rows) else "model"
    x = spec.pct(rows["q50"])
    y = spec.pct(rows["y"])
    fig, ax = charts.figure(
        "Actual against forecast, four quarters ahead",
        f"{_label(name)} median forecast against realized growth, one dot per metro and origin; test block, origins {rows['quarter'].min()} to {rows['quarter'].max()}; panel through {data_date}",
        size=(7.5, 7.2),
    )
    ax.scatter(x, y, s=6, color=charts.SERIES[0], alpha=0.12, linewidths=0, zorder=2)
    span = [float(min(x.min(), y.min())), float(max(x.max(), y.max()))]
    pad = 0.05 * (span[1] - span[0])
    span = [span[0] - pad, span[1] + pad]
    ax.plot(span, span, color=charts.AXIS, linewidth=1.0, zorder=1)
    ax.set_xlim(span)
    ax.set_ylim(span)
    ax.set_aspect("equal")
    charts.pct_axis(ax, "x")
    charts.pct_axis(ax, "y")
    ax.set_xlabel("median forecast, growth over four quarters")
    ax.set_ylabel("actual growth over four quarters")
    points = []
    for code, label in spec.SHOWCASE.items():
        sub = rows[rows["cbsa_code"] == code]
        if sub.empty:
            continue
        latest = sub.loc[sub["quarter"].idxmax()]
        px, py = float(spec.pct(latest["q50"])), float(spec.pct(latest["y"]))
        ax.plot([px], [py], marker="o", markersize=6, color=charts.SERIES[1], markeredgecolor=charts.SURFACE, markeredgewidth=1.2, zorder=7)
        points.append((px, py, f"{label}, {latest['quarter']}"))
    _label_points(ax, points, gap=0.035 * (span[1] - span[0]), dx=7)
    return charts.save(fig, "08_actual_vs_predicted")


def make_figures(summary, gbm_predictions, data_date):
    return [
        design_chart(data_date),
        errors_chart(summary, data_date),
        calibration_chart(summary, data_date),
        actual_vs_predicted_chart(gbm_predictions, data_date),
    ]


def main():
    panel = backtest.load_panel()
    started = time.perf_counter()
    combined, margins = run_all(panel)
    test = combined[combined["block"] == "test"]
    print("test block mae_pct by model and horizon")
    print(test.pivot(index="model", columns="horizon", values="mae_pct").reindex(list(MODELS)).round(2).to_string())
    print("conformal margins")
    print(margins.to_string(index=False))
    print(f"ridge alphas {RIDGE_ALPHA}")
    print(f"run_all took {time.perf_counter() - started:.0f}s")


if __name__ == "__main__":
    main()

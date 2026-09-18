# export the newest forecasts as map enrichment rows. bot/build_map_data.py
# reads results/forecast/metrics.csv in the collectors' contract, so the map
# files the model beside the collected sources, dated by the forecast origin

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from loop.spec import FORECAST_DIR, KEY, ML_ROOT, PANEL_PATH, TARGET_BASE, pct, quarter_end, shift_quarter

# fhfa's own standard error for the metro's index at the origin, as a share of
# that index. it is not a forecast, it rides along because the map reads this
# file and nothing else carries it
INDEX_ERROR = "hpi_rstderr_rel"

DATA_DIR = ML_ROOT / "data"
FORECASTS_PATH = FORECAST_DIR / "forecasts.csv"
METRICS_PATH = FORECAST_DIR / "metrics.csv"
MANIFEST_PATH = FORECAST_DIR / "download_manifest.json"
PROVIDER = "Loop forecasting model"
COLUMNS = ["cbsa_code", "metric", "period", "value"]

# the map's metric names. a forecast metric is one percent column of
# forecasts.csv at one horizon, the realized ones come from the panel and the
# surprise needs the backtest predictions as well
FORECAST_METRICS = {
    "hpi_forecast_4q": (4, "q50_pct"),
    "hpi_forecast_4q_lo": (4, "lo_pct"),
    "hpi_forecast_4q_hi": (4, "hi_pct"),
    "hpi_forecast_8q": (8, "q50_pct"),
    "hpi_forecast_8q_lo": (8, "lo_pct"),
    "hpi_forecast_8q_hi": (8, "hi_pct"),
}
REALIZED_METRICS = ["hpi_yoy_latest", "hpi_trend_5y", "hpi_index_error"]
SURPRISE_METRIC = "hpi_surprise_4q"
METRICS = list(FORECAST_METRICS) + REALIZED_METRICS + [SURPRISE_METRIC]


# cbsa codes are five digit strings. one that lost its leading zero on the
# way through an integer column gets it back, and one that came through a
# float column reads 10180.0, which is already five characters, so zfill
# leaves it alone and the same metro lands in the file twice under two codes.
# anything that is not five digits after that stops the export, because on the
# map it is a metro that silently never matches
def codes(series):
    text = series.astype(str).str.strip()
    numeric = pd.to_numeric(text, errors="coerce")
    whole = numeric.notna() & (numeric % 1 == 0) & (numeric >= 0)
    text = text.mask(whole, numeric.where(whole).astype("Int64").astype(str))
    bad = sorted(set(text[~text.str.fullmatch(r"\d{1,5}")]))
    if bad:
        raise ValueError(f"cbsa codes are five digits, these are not: {bad[:5]}")
    return text.str.zfill(5)


# the newest origin in a forecasts frame, "2026Q2" style strings sort right
def latest_origin(forecasts):
    return str(forecasts["origin"].max())


# the origin quarter's last month, "2026-06" for 2026Q2. the map keeps the
# newest period per metric as latest and shows this date beside it
def period_of(origin):
    return quarter_end(origin).strftime("%Y-%m")


def _pct(series):
    return pd.Series(pct(series), index=series.index)


# long rows for one metric from a series indexed by cbsa_code, nulls dropped
def _rows(values, metric, period):
    out = values.dropna().rename("value").rename_axis("cbsa_code").reset_index()
    out["metric"] = metric
    out["period"] = period
    return out[COLUMNS]


# the point and band columns at the horizons the map shows, by metro
def forecast_values(forecasts, origin):
    latest = forecasts[forecasts["origin"] == origin]
    out = {}
    for metric, (horizon, column) in FORECAST_METRICS.items():
        sub = latest[latest["horizon"].astype(int) == horizon]
        if sub["cbsa_code"].duplicated().any():
            raise ValueError(f"more than one forecast per metro at horizon {horizon}")
        out[metric] = sub.set_index("cbsa_code")[column].astype(float)

    # the map draws a band around every point it shows, so an edge that went
    # missing is a broken contract, not a metro with less data
    for horizon in sorted({h for h, _ in FORECAST_METRICS.values()}):
        point = out[f"hpi_forecast_{horizon}q"]
        for edge in ("lo", "hi"):
            name = f"hpi_forecast_{horizon}q_{edge}"
            bare = point.notna() & out[name].reindex(point.index).isna()
            if bare.any():
                raise ValueError(f"{int(bare.sum())} forecasts with no {name}")
    return out


# realized growth from the panel at the origin: over the last four quarters,
# and annualized over the last twenty. a metro missing either quarter is null
def realized_values(panel, origin):
    wide = panel.pivot(index="cbsa_code", columns="quarter", values=TARGET_BASE)

    def level(quarter):
        return wide[quarter] if quarter in wide.columns else pd.Series(np.nan, index=wide.index)

    now = level(origin)
    out = {
        "hpi_yoy_latest": _pct(now - level(shift_quarter(origin, -4))),
        "hpi_trend_5y": _pct((now - level(shift_quarter(origin, -20))) / 5.0),
    }
    at_origin = panel[panel["quarter"] == origin].set_index("cbsa_code")[INDEX_ERROR]
    out["hpi_index_error"] = at_origin.astype(float).dropna()
    return out


# realized four quarter growth to the origin minus the median the model gave
# for that window at made, the origin four quarters earlier, in percentage
# points. positive means the metro grew more than expected. only test block
# rows count, so the miss is out of sample
def surprise_values(predictions, made, realized):
    rows = predictions[
        (predictions["quarter"] == made) & (predictions["horizon"].astype(int) == 4) & (predictions["block"] == "test")
    ]
    expected = _pct(rows.set_index("cbsa_code")["q50"].astype(float))
    return (realized - expected).dropna()


# every metric for every metro that has it, one row each, in the contract
# columns. a metro absent from the panel keeps its forecast rows only
def build_metrics(forecasts, panel, predictions=None):
    if forecasts.empty:
        raise ValueError("no forecast rows to export")
    forecasts = forecasts.assign(cbsa_code=codes(forecasts["cbsa_code"]))
    panel = panel.assign(cbsa_code=codes(panel["cbsa_code"]))
    origin = latest_origin(forecasts)
    period = period_of(origin)
    values = forecast_values(forecasts, origin)
    values.update(realized_values(panel, origin))
    # every metric above is measured at the live origin. the surprise scores a
    # call the model published four quarters earlier, so it carries the origin
    # that call was made at, not the one its outcome landed in
    periods = {}
    if predictions is not None:
        predictions = predictions.assign(cbsa_code=codes(predictions["cbsa_code"]))
        made = shift_quarter(origin, -4)
        values[SURPRISE_METRIC] = surprise_values(predictions, made, values["hpi_yoy_latest"])
        periods[SURPRISE_METRIC] = period_of(made)
    out = pd.concat([_rows(series, metric, periods.get(metric, period)) for metric, series in values.items()],
                    ignore_index=True)
    out["value"] = out["value"].astype(float).round(4)
    return out.sort_values(["cbsa_code", "metric"], kind="stable").reset_index(drop=True)


def write_metrics(metrics, path=METRICS_PATH):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    metrics.to_csv(path, index=False, lineterminator="\n")
    return path


# same chunked hash as the pipeline scripts
def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            digest.update(chunk)
    return digest.hexdigest()


# same shape as the collectors' download_manifest.json, so the bot's sources
# block reads the version and a reader finds the hash where the other folders
# keep it. the version names the model and its origin quarter
def manifest_entry(path, metrics, model, origin, inputs=()):
    path = Path(path)
    counts = metrics["metric"].value_counts().sort_index()
    return {
        "filename": path.name,
        "file_format": "CSV",
        "source": {
            "endpoint": "loop.export",
            "provider": PROVIDER,
            "access_method": "computed",
            "dataset": "house price index growth forecasts with 90 percent conformal bands, "
                       "realized growth and forecast surprise by metro",
        },
        "integrity": {
            "sha256": sha256_file(path),
            "size_kb": round(path.stat().st_size / 1024, 1),
            "row_count": int(len(metrics)),
        },
        "version": f"{model}, origin {origin}",
        "downloaded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "notes": {
            "model": model,
            "origin": origin,
            "period": period_of(origin),
            "horizons": sorted({h for h, _ in FORECAST_METRICS.values()}),
            "metros": int(metrics["cbsa_code"].nunique()),
            "rows_by_metric": {metric: int(n) for metric, n in counts.items()},
            "inputs": {Path(p).name: sha256_file(p) for p in inputs if Path(p).exists()},
        },
    }


# a rewrite that only moves the timestamp is not a change. the export runs on
# every retrain and the map's own writers already refuse to rewrite themselves
# for a stamp; this one did not, so an export that landed on the same numbers
# still showed up as a commit and pulled a deploy behind it
def write_manifest(entries, path=MANIFEST_PATH):
    path = Path(path)
    if path.exists():
        try:
            previous = json.loads(path.read_text())
        except ValueError:
            previous = None
        if isinstance(previous, list) and len(previous) == len(entries):
            restamped = [{**new, "downloaded_at": old.get("downloaded_at", new.get("downloaded_at"))}
                         for new, old in zip(entries, previous) if isinstance(old, dict)]
            if restamped == previous:
                return path
    path.write_text(json.dumps(entries, indent=2) + "\n")
    return path


# read the newest forecasts, the panel and the matching backtest predictions,
# then write metrics.csv and its manifest. from ml: python -m loop.export
def main():
    if not FORECASTS_PATH.exists():
        raise FileNotFoundError(f"{FORECASTS_PATH.name} is missing, run the forecast first")
    forecasts = pd.read_csv(FORECASTS_PATH, dtype={"cbsa_code": str, "origin": str, "model": str})
    if not PANEL_PATH.exists():
        raise FileNotFoundError(f"{PANEL_PATH.name} is missing, build the panel first")
    panel = pd.read_parquet(PANEL_PATH, columns=KEY + [TARGET_BASE, INDEX_ERROR])
    model = str(forecasts["model"].iloc[0])
    predictions_path = DATA_DIR / f"predictions_{model}.parquet"
    predictions = pd.read_parquet(predictions_path) if predictions_path.exists() else None
    if predictions is None:
        print(f"[export] {predictions_path.name} not found, {SURPRISE_METRIC} is skipped")
    metrics = build_metrics(forecasts, panel, predictions)
    write_metrics(metrics, METRICS_PATH)
    inputs = [FORECASTS_PATH, PANEL_PATH] + ([predictions_path] if predictions is not None else [])
    origin = latest_origin(forecasts)
    write_manifest([manifest_entry(METRICS_PATH, metrics, model, origin, inputs)], MANIFEST_PATH)
    print(f"[export] {len(metrics)} rows for {metrics['cbsa_code'].nunique()} metros, "
          f"{model} at {origin} -> {METRICS_PATH.name}")
    return METRICS_PATH


if __name__ == "__main__":
    main()

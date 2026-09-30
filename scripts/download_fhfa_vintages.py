# every published vintage of fhfa's all-transactions index for the study's
# metros, from alfred, the st. louis fed's archive of what each release said
# at the time. hpi_master.csv is only the latest vintage, and fhfa revises past
# quarters as later sales come in, so a backtest that reads it reads history
# no forecaster had. alfred's vintages of these series begin with the 2013-05
# release, so every origin from 2013 on can be read as it was published.
#
# a renumbered metro has its older vintages under its former code, and those
# rows are filed under the current one. needs FRED_API_KEY in the environment.
#
# from the repo root:  ml/.venv/bin/python scripts/download_fhfa_vintages.py

import hashlib
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))
from scripts.download_census import DIVISION_CROSSWALK, MSA_CROSSWALK  # noqa: E402

RAW_DIR = BASE_DIR / "data" / "raw" / "fhfa_vintages"
METROS_FILE = BASE_DIR / "data" / "integrated" / "hpi_census_merged.csv"
OUT_FILE = "vintages.csv"
URL = "https://api.stlouisfed.org/fred/series/observations"
FIRST_VINTAGE = "2013-01-01"
# fred allows 120 requests a minute
PAUSE = 0.6
FORMER_CODE = {new: old for old, new in {**DIVISION_CROSSWALK, **MSA_CROSSWALK}.items()}
COLUMNS = ["cbsa_code", "series_id", "date", "value", "realtime_start", "realtime_end"]


def series_id(code):
    return f"ATNHPIUS{code}Q"


def metros():
    frame = pd.read_csv(METROS_FILE, dtype={"cbsa_code": str}, usecols=["cbsa_code"])
    return sorted(frame["cbsa_code"].unique())


# every observation of one series with the span of vintages it held for. a
# series fred does not carry answers 400, which is None here, not an error
def fetch(sid, key):
    response = requests.get(URL, params={
        "series_id": sid, "api_key": key, "file_type": "json",
        "realtime_start": FIRST_VINTAGE, "realtime_end": "9999-12-31", "limit": 100000,
    }, timeout=60)
    if response.status_code == 400:
        return None
    response.raise_for_status()
    rows = response.json().get("observations", [])
    frame = pd.DataFrame(rows, columns=["realtime_start", "realtime_end", "date", "value"])
    frame["value"] = pd.to_numeric(frame["value"], errors="coerce")
    return frame.dropna(subset=["value"]).assign(series_id=sid)


# a metro's rows from its own series, and from its former code's for any
# vintage its own series was not yet published in. a discontinued series
# leaves its last vintage open ended, so the former code's rows are closed the
# day before the own series' first release, or every later vintage would
# carry the metro twice
def stitch(code, own, former):
    parts = []
    if own is not None and not own.empty:
        parts.append(own)
    if former is not None and not former.empty:
        first_own = own["realtime_start"].min() if own is not None and not own.empty else "9999-12-31"
        kept = former[former["realtime_start"] < first_own].copy()
        if first_own != "9999-12-31":
            day_before = (pd.Timestamp(first_own) - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
            kept["realtime_end"] = kept["realtime_end"].where(kept["realtime_end"] < first_own, day_before)
        parts.append(kept)
    if not parts:
        return None
    return pd.concat(parts, ignore_index=True).assign(cbsa_code=code)[COLUMNS]


def main():
    key = os.environ.get("FRED_API_KEY")
    if not key:
        sys.exit("FRED_API_KEY is not set, so alfred cannot be read")
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    codes = metros()
    frames, missing = [], []
    for i, code in enumerate(codes, 1):
        own = fetch(series_id(code), key)
        time.sleep(PAUSE)
        former = None
        if code in FORMER_CODE:
            former = fetch(series_id(FORMER_CODE[code]), key)
            time.sleep(PAUSE)
        rows = stitch(code, own, former)
        if rows is None:
            missing.append(code)
        else:
            frames.append(rows)
        if i % 50 == 0:
            print(f"{i} of {len(codes)} metros read", flush=True)
    out = pd.concat(frames, ignore_index=True).sort_values(["cbsa_code", "date", "realtime_start"])
    if out.empty:
        sys.exit("alfred returned no vintages, so the archive is left as it was")
    # staged beside the archive and renamed over it only when whole, with the
    # manifest written last
    with tempfile.TemporaryDirectory(dir=RAW_DIR, prefix=".staging-") as staging:
        staged = Path(staging) / OUT_FILE
        out.to_csv(staged, index=False)
        sha = hashlib.sha256(staged.read_bytes()).hexdigest()
        manifest = [{
            "filename": OUT_FILE,
            "file_format": "CSV",
            "source": {"url": URL, "provider": "Federal Reserve Bank of St. Louis, ALFRED",
                       "series": "ATNHPIUS<cbsa>Q, FHFA all-transactions house price index",
                       "access_method": "FRED API, every vintage from " + FIRST_VINTAGE},
            "integrity": {"sha256": sha, "size_kb": round(staged.stat().st_size / 1024, 1), "row_count": int(len(out))},
            "version": str(out["realtime_start"].max()),
            "metros": int(out["cbsa_code"].nunique()),
            "metros_without_a_series": missing,
            "downloaded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }]
        (Path(staging) / "download_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        os.replace(staged, RAW_DIR / OUT_FILE)
        os.replace(Path(staging) / "download_manifest.json", RAW_DIR / "download_manifest.json")
    print(f"{len(out)} rows for {out['cbsa_code'].nunique()} metros, latest vintage {out['realtime_start'].max()}, "
          f"{len(missing)} metros without a series: {missing}")


if __name__ == "__main__":
    main()

import pandas as pd

from bot import indicators
from bot.collectors.fred import parse_observations
from bot.common import RAW_DIR, env_key, fetch, manifest_entry, write_csv, write_manifest

OUT_DIR = RAW_DIR / "national"
OUT_FILE = OUT_DIR / "indicators.csv"
ENDPOINT = "https://api.stlouisfed.org/fred/series/observations"
# the strip shows five years and the forecasting panel reaches back to 1975,
# so the pull takes each series from its own beginning. fred answers with
# whatever it has, so a series that starts in 2009 still starts in 2009
START = "1954-01-01"

# a daily series is five thousand rows and the strip reads one number a month,
# so these are cut to the last observation of each month before they are written
DAILY = ("DGS1", "DGS10", "EFFR", "DFEDTARU")

COLUMNS = ["series_id", "date", "value"]


# the last observation of each calendar month, keeping its published date.
# rows without a value go first, so a holiday on the last business day of a
# month cannot blank that month
def month_end(df):
    kept = df.dropna(subset=["value"]).sort_values("date")
    return kept[~kept["date"].str[:7].duplicated(keep="last")]


def collect():
    key = env_key("FRED_API_KEY")
    if not key:
        raise RuntimeError("FRED_API_KEY is not set")

    series_ids = indicators.series_ids()
    frames, empty = [], []
    for series in series_ids:
        response = fetch(ENDPOINT, params={
            "series_id": series, "api_key": key, "file_type": "json",
            "observation_start": START,
        })
        # never let the url, which carries the key, into an error message
        if not response.ok:
            raise RuntimeError(f"fred returned HTTP {response.status_code} for {series}")

        df = parse_observations(response.json()["observations"])
        if not len(df):
            print(f"[national] {series}: no observations")
            empty.append(series)
            continue

        daily = series in DAILY
        if daily:
            df = month_end(df)
        frames.append(df.assign(series_id=series)[COLUMNS])
        shape = "monthly last value" if daily else "as published"
        print(f"[national] {series}: {len(df)} rows through {df['date'].iloc[-1]}, {shape}")

    out = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=COLUMNS)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_csv(out, OUT_FILE)
    write_manifest(OUT_DIR, [manifest_entry(
        OUT_FILE, ENDPOINT, "Federal Reserve Bank of St. Louis, FRED",
        "national indicators for the map's dashboard strip, one row per series and observation",
        f"through {out['date'].max()}", len(out),
        {
            "series": series_ids,
            "daily_series_cut_to_the_last_observation_of_each_month": list(DAILY),
            "missing_observations": "fred publishes a dot, written here as an empty value",
        },
    )])
    silent = f", {len(empty)} with nothing to download" if empty else ""
    print(f"[national] {len(frames)} of {len(series_ids)} series{silent}, {len(out)} rows "
          f"through {out['date'].max()} -> {OUT_FILE.name}")
    return OUT_FILE

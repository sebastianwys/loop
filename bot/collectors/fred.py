import pandas as pd

from bot.common import RAW_DIR, env_key, fetch, manifest_entry, write_manifest

OUT_DIR = RAW_DIR / "fred"
OUT_FILE = OUT_DIR / "mortgage30us.csv"
ENDPOINT = "https://api.stlouisfed.org/fred/series/observations"
SERIES = "MORTGAGE30US"  # freddie mac 30 year fixed, weekly, national
# the series itself starts here. the panel reaches back to 1975 and the rate
# is its only macro channel, so the forecasting block was fitting on half a
# column until the start moved off an arbitrary 2000
START = "1971-04-02"


# fred marks missing weeks with a dot. columns are named up front so an
# empty response still yields the two column frame
def parse_observations(observations):
    df = pd.DataFrame(observations, columns=["date", "value"])
    df["value"] = pd.to_numeric(df["value"].replace(".", None), errors="coerce")
    return df


def collect():
    key = env_key("FRED_API_KEY")
    if not key:
        raise RuntimeError("FRED_API_KEY is not set")

    print(f"[fred] fetching {SERIES}")
    response = fetch(ENDPOINT, params={
        "series_id": SERIES, "api_key": key, "file_type": "json",
        "observation_start": START,
    })
    # never let the url, which carries the key, into an error message
    if not response.ok:
        raise RuntimeError(f"fred returned HTTP {response.status_code}")

    df = parse_observations(response.json()["observations"])

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT_FILE, index=False)
    write_manifest(OUT_DIR, [manifest_entry(
        OUT_FILE, f"{ENDPOINT}?series_id={SERIES}", "Federal Reserve Bank of St. Louis, FRED",
        "30-year fixed rate mortgage average in the United States, weekly",
        f"through {df['date'].iloc[-1]}", len(df),
    )])
    print(f"[fred] {len(df)} weekly observations through {df['date'].iloc[-1]} -> {OUT_FILE.name}")
    return OUT_FILE

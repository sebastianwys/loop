from datetime import date

import pandas as pd

from bot.common import INTEGRATED, RAW_DIR, env_key, fetch, manifest_entry, write_manifest
from bot.collectors.gazetteer import OUT_FILE as CENTROIDS

OUT_DIR = RAW_DIR / "bls"
OUT_FILE = OUT_DIR / "laus_metro_unemployment.csv"
API = "https://api.bls.gov/publicAPI/v2/timeseries/data/"

# laus metro area unemployment rate, not seasonally adjusted. annual averages
# come back as period M13 when annualaverage is requested
MEASURE = "03"

STATE_FIPS = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06", "CO": "08", "CT": "09",
    "DE": "10", "DC": "11", "FL": "12", "GA": "13", "HI": "15", "ID": "16", "IL": "17",
    "IN": "18", "IA": "19", "KS": "20", "KY": "21", "LA": "22", "ME": "23", "MD": "24",
    "MA": "25", "MI": "26", "MN": "27", "MS": "28", "MO": "29", "MT": "30", "NE": "31",
    "NV": "32", "NH": "33", "NJ": "34", "NM": "35", "NY": "36", "NC": "37", "ND": "38",
    "OH": "39", "OK": "40", "OR": "41", "PA": "42", "RI": "44", "SC": "45", "SD": "46",
    "TN": "47", "TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53", "WV": "54",
    "WI": "55", "WY": "56", "PR": "72",
}


# bls files a few cross-state metros under a state other than the first listed
STATE_OVERRIDES = {
    "19340": "IL",  # davenport-moline-rock island, ia-il
    "48260": "OH",  # weirton-steubenville, wv-oh
}


# "Chicago-Naperville-Elgin, IL-IN-WI Metro Area" -> "IL". bls files a
# multi-state metro under its principal city's state, which is listed first
def primary_state(name):
    return name.split(",")[1].strip().split()[0].split("-")[0]


# the laus metro series begin here, and the forecasting panel fits on outcomes
# through 2017, so a pull that started at 2014 left unemployment blank in all
# but a ninth of the fitting block
FIRST_YEAR = 1990


# [first, last] year pairs of at most span years, oldest first
def year_windows(first_year, end_year, span):
    edges = range(first_year, end_year + 1, span)
    return [(start, min(start + span - 1, end_year)) for start in edges]


# area type MT for a metropolitan statistical area, DV for a metropolitan division
def series_id(cbsa_code, state_abbr, division=False):
    area_type = "DV" if division else "MT"
    return f"LAU{area_type}{STATE_FIPS[state_abbr]}{cbsa_code}000000{MEASURE}"


# keep every month and the annual average (period M13) per series. the map
# reads the annual average per year and the newest month, the forecasting
# panel averages the months into quarters
def parse_series(series):
    rows = []
    for item in series:
        for d in item.get("data", []):
            rows.append({
                "series_id": item["seriesID"],
                "cbsa_code": item["seriesID"][7:12],
                "year": int(d["year"]),
                "period": d["period"],
                "value": float(d["value"]) if d["value"] != "-" else None,
            })
    return pd.DataFrame(rows, columns=["series_id", "cbsa_code", "year", "period", "value"])


def collect():
    key = env_key("BLS_API_KEY")
    # keyless: 25 series per query, 25 queries a day, 10 years per query, and
    # bls silently drops the newest years past the cap. with a key: 50 series,
    # 500 queries, 20 years. so keyless takes the newest window only, which
    # keeps 2019 and 2024 but not 2014, and a keyed run walks back to 1990 one
    # window at a time
    end_year = date.today().year
    chunk = 50 if key else 25
    span = 20 if key else 10
    windows = year_windows(FIRST_YEAR, end_year, span) if key else [(end_year - span + 1, end_year)]
    start_year = windows[0][0]
    if not key:
        print(f"[bls] no BLS_API_KEY, pulling {start_year} onward only")

    metros = pd.read_csv(INTEGRATED, dtype={"cbsa_code": str})["cbsa_code"].unique()
    geo = pd.read_csv(CENTROIDS, dtype={"cbsa_code": str}).drop_duplicates("cbsa_code").set_index("cbsa_code")

    ids = {}
    for code in metros:
        if code in geo.index:
            state = STATE_OVERRIDES.get(code) or primary_state(geo.loc[code, "name"])
            division = int(geo.loc[code, "cbsa_type"]) == 3
            ids[series_id(code, state, division)] = code

    frames, missing = [], []
    id_list = list(ids)
    query = 0
    for first, last in windows:
        for i in range(0, len(id_list), chunk):
            batch = id_list[i:i + chunk]
            body = {"seriesid": batch, "startyear": str(first), "endyear": str(last),
                    "annualaverage": True}
            if key:
                body["registrationkey"] = key
            query += 1
            print(f"[bls] query {query}, {len(batch)} series, {first} to {last}")
            response = fetch(API, json_body=body)
            payload = response.json()
            if payload.get("status") != "REQUEST_SUCCEEDED":
                raise RuntimeError(f"bls: {payload.get('status')}: {payload.get('message')}")
            missing += [m for m in payload.get("message", []) if "does not exist" in m]
            frames.append(parse_series(payload["Results"]["series"]))

    # a series that answered in two windows cannot hand back the same month
    # twice, and the newest window wins if it ever did
    df = pd.concat(frames, ignore_index=True)
    df = df.drop_duplicates(["series_id", "year", "period"], keep="last")
    df = df.sort_values(["series_id", "year", "period"]).reset_index(drop=True)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT_FILE, index=False)
    write_manifest(OUT_DIR, [manifest_entry(
        OUT_FILE, API, "U.S. Bureau of Labor Statistics",
        "Local Area Unemployment Statistics, metropolitan area unemployment rate, not seasonally adjusted",
        f"{start_year} onward, every month plus annual averages", len(df),
        {"series_requested": len(ids), "series_missing": len(missing), "keyed": bool(key)},
    )])
    print(f"[bls] {df['series_id'].nunique()} of {len(ids)} series, {len(missing)} missing -> {OUT_FILE.name}")
    return OUT_FILE

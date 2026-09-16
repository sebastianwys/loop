import os
import sys
import requests
import pandas as pd
import json
import hashlib
from pathlib import Path
from datetime import datetime, timezone

BASE_DIR = Path(__file__).parent.parent
RAW_DIR = BASE_DIR / "data" / "raw" / "census"
RAW_DIR.mkdir(parents=True, exist_ok=True)

BASE_URL = "https://api.census.gov/data/{year}/acs/acs5"

# keyless catalog of every census api dataset, used to find the newest vintage
CATALOG_URL = "https://api.census.gov/data.json"

# the pinned end years. discovery writes this file, the pipeline reads it, so a
# rerun never silently moves the study forward when census publishes a vintage
VINTAGES_FILE = RAW_DIR / "vintages.json"

# b15003 does not exist before the 2012 vintage. earlier endpoints carry b15002,
# which is split by sex, so the variable list below 404s there
MIN_VINTAGE = 2012

# three non-overlapping 5-year windows, 15 years of coverage
SPAN = 5
N_BATCHES = 3

MSA_COL = "metropolitan statistical area/micropolitan statistical area"
DIV_COL = "metropolitan division"

# the msas that omb splits into metropolitan divisions, july 2023 delineation.
# fhfa publishes these thirteen only as divisions, so the divisions are pulled
# too and join on their own codes. the api needs one call per parent
DIVISION_PARENTS = [
    "12060", "14460", "16980", "19100", "19820", "31080", "33100",
    "35620", "37980", "41860", "42660", "45300", "47900",
]

# division codes that changed between delineations with the same counties
# underneath, mapped to the current code so the older vintages join
DIVISION_CROSSWALK = {
    "16974": "16984",  # chicago-naperville-arlington heights -> chicago-naperville-schaumburg
    "23844": "29414",  # gary, in -> lake county-porter county-jasper county, in
    "43524": "23224",  # silver spring-frederick-rockville -> frederick-gaithersburg-bethesda
    "35154": "29484",  # new brunswick-lakewood -> lakewood-new brunswick
}

# add codes here to pull more columns
# B19013_001E = median household income
# B01003_001E = total population
# B01002_001E = median age
# B15003_022E = bachelors degree count
# B15003_023E = masters degree count
# B25003_001E = total occupied housing units
# B25003_002E = owner occupied housing units
# B25077_001E = median home value
VARIABLES = [
    "NAME",
    "B19013_001E",
    "B01003_001E",
    "B01002_001E",
    "B15003_022E",
    "B15003_023E",
    "B25003_001E",
    "B25003_002E",
    "B25077_001E",
]


# same chunked hash as fhfa
def compute_sha256(filepath):
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        while True:
            chunk = f.read(8192)
            if not chunk:
                break
            sha256.update(chunk)
    return sha256.hexdigest()


# the api key. environment first, then an optional dotenv file named by
# CENSUS_ENV_FILE. no local path is hardcoded so this file stays publishable
def load_api_key(var="CENSUS_API_KEY", env_file=None):
    key = os.environ.get(var, "").strip()
    if key:
        return key

    env_file = env_file or os.environ.get("CENSUS_ENV_FILE")
    if env_file:
        for line in Path(env_file).read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            if name.strip() == var:
                return value.strip().strip('"').strip("'")

    raise RuntimeError(
        f"{var} is not set. export it, or point CENSUS_ENV_FILE at a dotenv file "
        "that defines it. signup: https://api.census.gov/data/key_signup.html"
    )


# keep the key out of logs. requests puts the full url, query string included,
# into HTTPError messages
def redact(text, key):
    return text.replace(key, "***") if key else text


# the census dcat catalog. keyless, tens of mb, so fetch once and never in a loop
def fetch_catalog(timeout=60):
    response = requests.get(CATALOG_URL, timeout=timeout)
    response.raise_for_status()
    return response.json()


# newest published end year for a dataset. pure, so it tests offline
def latest_vintage(catalog, dataset=("acs", "acs5")):
    vintages = [
        entry.get("c_vintage")
        for entry in catalog.get("dataset", [])
        if entry.get("c_dataset") == list(dataset) and entry.get("c_vintage")
    ]
    if not vintages:
        raise RuntimeError(f"no vintages for {'/'.join(dataset)} in the catalog")
    return max(vintages)


# inclusive (start, end) for one vintage. 2014 -> (2010, 2014), five years
def window(end_year, span=SPAN):
    return (end_year - span + 1, end_year)


# end years newest first. 2024 -> [2024, 2019, 2014], covering 2010 to 2024.
# the floor applies to the end year because that is the endpoint we request
def acs_batches(latest, n_batches=N_BATCHES, span=SPAN):
    years = [latest - i * span for i in range(n_batches)]
    if years[-1] < MIN_VINTAGE:
        raise ValueError(
            f"oldest vintage {years[-1]} is below the {MIN_VINTAGE} floor where "
            "B15003 first appears. lower n_batches or change the variable list"
        )
    return years


# the end years to pull. pinned unless refresh is set, so the dag and the
# manifest stay reproducible across runs
def resolve_years(refresh=False):
    if VINTAGES_FILE.exists() and not refresh:
        return json.loads(VINTAGES_FILE.read_text())["years"]

    latest = latest_vintage(fetch_catalog())
    years = acs_batches(latest)

    pin = {
        "years": years,
        "windows": {str(y): list(window(y)) for y in years},
        "span": SPAN,
        "latest_available": latest,
        "catalog": CATALOG_URL,
        "resolved_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    VINTAGES_FILE.write_text(json.dumps(pin, indent=2) + "\n")
    print(f"Pinned vintages {years}, latest available {latest}")

    return years


# tag rows with the code the merge joins on. msas join on their own code,
# divisions on the division code, crosswalked when a delineation renamed it.
# the api columns stay as they came
def tag_geography(df, level):
    df = df.copy()
    df["geo_level"] = level
    if level == "division":
        df["geo_code"] = df[DIV_COL].map(lambda code: DIVISION_CROSSWALK.get(code, code))
        df["parent_cbsa"] = df[MSA_COL]
    else:
        df["geo_code"] = df[MSA_COL]
        df["parent_cbsa"] = ""
    return df


# pull one vintage: every msa and micro, plus the divisions of the split msas
def fetch_acs_data(year, api_key):
    print(f"Fetching ACS 5-year data for {year}...")
    frames = [tag_geography(query_acs(year, api_key, f"{MSA_COL}:*"), "msa")]
    for parent in DIVISION_PARENTS:
        divisions = query_acs(year, api_key, f"{DIV_COL}:*", within=f"{MSA_COL}:{parent}")
        frames.append(tag_geography(divisions, "division"))

    df = pd.concat(frames, ignore_index=True)
    df["year"] = year  # tag rows so we know the vintage after concat
    order = VARIABLES + [MSA_COL, DIV_COL, "geo_level", "geo_code", "parent_cbsa", "year"]
    print(f"  {(df.geo_level == 'msa').sum()} msas and micros, {(df.geo_level == 'division').sum()} divisions")
    return df[order]


# one api call. everything comes back as strings
def query_acs(year, api_key, geography, within=None):
    url = BASE_URL.format(year=year)
    params = {"get": ",".join(VARIABLES), "for": geography, "key": api_key}
    if within:
        params["in"] = within

    response = requests.get(url, params=params, timeout=60)

    # a parent with no divisions in that vintage answers 204 with an empty body
    if response.status_code == 204:
        return pd.DataFrame(columns=VARIABLES + [MSA_COL, DIV_COL])

    # check the status before the body, so a 5xx with an empty body is an error
    # and not a silent "no divisions here"
    try:
        response.raise_for_status()
    except requests.HTTPError as e:
        raise requests.HTTPError(redact(str(e), api_key)) from None

    # some vintages answer 200 with an empty body instead of 204
    if not response.content.strip():
        return pd.DataFrame(columns=VARIABLES + [MSA_COL, DIV_COL])

    # a missing, unactivated or invalid key redirects to an html page that still
    # returns 200, so the status code alone does not prove this is data
    content_type = response.headers.get("content-type", "")
    if "json" not in content_type:
        raise RuntimeError(
            f"expected json from {url}, got {content_type}. usually a missing, "
            "unactivated or invalid CENSUS_API_KEY"
        )

    data = response.json()
    headers = data[0]  # row 0 is column names
    rows = data[1:]

    return pd.DataFrame(rows, columns=headers)


# remove stale years, pull fresh data, write combined csv and manifest
def main():
    years = resolve_years(refresh="--refresh-vintages" in sys.argv)
    api_key = load_api_key()

    start, end = window(years[-1])[0], years[0]
    print(f"Vintages {years}, covering {start} to {end}")

    manifest = []
    all_frames = []
    failed = []

    # pull oldest first so the combined csv and the manifest stay in ascending
    # year order. acs_batches returns newest first
    for year in sorted(years):
        try:
            df = fetch_acs_data(year, api_key)
            all_frames.append(df)

            filename = f"acs_5yr_{year}.csv"
            filepath = RAW_DIR / filename
            df.to_csv(filepath, index=False)

            checksum = compute_sha256(filepath)
            size_kb = filepath.stat().st_size / 1024

            print(f"  Saved {filepath} ({len(df)} rows, {size_kb:.1f} KB)")
            print(f"  SHA-256: {checksum}")

            manifest.append({
                "filename": filename,
                "file_format": "CSV",
                "source": {
                    "endpoint": BASE_URL.format(year=year),  # bare, no key
                    "provider": "U.S. Census Bureau",
                    "access_method": "REST API",
                    "dataset": "ACS 5-year estimates",
                    "geography": f"{MSA_COL}:* plus {DIV_COL}:* within {len(DIVISION_PARENTS)} split msas",
                    "variables": VARIABLES
                },
                "integrity": {
                    "sha256": checksum,
                    "size_kb": round(size_kb, 1),
                    "row_count": len(df)
                },
                "version": f"ACS 5-year {year}",
                "survey_window": list(window(year)),
                "downloaded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            })

        except Exception as e:
            failed.append(year)
            # type(e).__name__ tells you what kind of failure
            print(f"  ERROR {year}: {type(e).__name__}: {redact(str(e), api_key)}")
            print(f"  Endpoint: {BASE_URL.format(year=year)}")
            print(f"  Variables attempted: {VARIABLES}")
            print(f"  This vintage may have different variable codes. Skipping.")

    if failed:
        # a partial pull published over a complete one cannot be undone, so the
        # combined csv and the manifest keep describing the last good run
        sys.exit(
            f"Census ACS download incomplete, vintages failed: {failed}. "
            "The previous combined csv and manifest were left in place."
        )

    combined = pd.concat(all_frames, ignore_index=True)
    combined_path = RAW_DIR / "acs_5yr_combined.csv"
    combined.to_csv(combined_path, index=False)
    print(f"\nCombined file: {combined_path} ({len(combined)} total rows)")

    manifest_path = RAW_DIR / "download_manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Manifest saved to {manifest_path}")

    # the pinned years changed, so per-year csvs off the study go now that their
    # replacements are on disk. a failed run above never reaches this
    for stale in RAW_DIR.glob("acs_5yr_*.csv"):
        year_str = stale.stem.replace("acs_5yr_", "")
        if year_str.isdigit() and int(year_str) not in years:
            stale.unlink()
            print(f"Removed stale file: {stale.name}")

    print("Census ACS download complete.")


if __name__ == "__main__":
    main()

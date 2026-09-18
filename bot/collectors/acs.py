import sys
import unicodedata

import pandas as pd

from bot.common import BASE_DIR, RAW_DIR, STUDY_YEARS, env_key, fetch, manifest_entry, staged_folder

# scripts/ is not a package, so put it on the path before importing the
# pipeline's geography constants and the division tagging it already tests
sys.path.insert(0, str(BASE_DIR / "scripts"))

from download_census import DIV_COL, DIVISION_CROSSWALK, DIVISION_PARENTS, MSA_COL, tag_geography

OUT_DIR = RAW_DIR / "acs"
OUT_FILE = OUT_DIR / "metrics.csv"
BASE_URL = "https://api.census.gov/data/{year}/acs/acs5"
# keyless catalog entry for one variable. 404 means the vintage lacks it
VARIABLE_URL = BASE_URL + "/variables/{code}.json"
PROVIDER = "U.S. Census Bureau"

# the vintages are the study years
VINTAGES = list(STUDY_YEARS)

# census marks a missing estimate with a large negative sentinel
SENTINEL = -666666

# the map contract
COLUMNS = ["cbsa_code", "metric", "period", "value"]

# B25064_001E = median gross rent in dollars
# B25070 = gross rent as a share of household income: _001E renter households,
#   _007E to _010E paying 30 percent or more, _011E not computed
# B25002 = occupancy status: _001E housing units, _003E vacant
# B08013_001E = aggregate minutes to work, B08012_001E = workers who commute
# B17001 = poverty status: _001E universe, _002E below the poverty level
# B23025 = employment status: _001E population 16 and over, _002E in labor force
#
# each metric is a numerator over a denominator, both sums of codes. "less" is
# subtracted from the denominator. gross_rent has no denominator, it is the
# published median as is
METRICS = {
    "gross_rent": {"num": ["B25064_001E"]},
    "rent_burden": {"num": ["B25070_007E", "B25070_008E", "B25070_009E", "B25070_010E"],
                    "den": ["B25070_001E"], "less": ["B25070_011E"]},
    "vacancy_rate": {"num": ["B25002_003E"], "den": ["B25002_001E"]},
    "commute_minutes": {"num": ["B08013_001E"], "den": ["B08012_001E"]},
    "poverty_rate": {"num": ["B17001_002E"], "den": ["B17001_001E"]},
    "labor_force_rate": {"num": ["B23025_002E"], "den": ["B23025_001E"]},
}

VARIABLES = list(dict.fromkeys(code for spec in METRICS.values() for part in spec.values() for code in part))


# every code a metric needs
def metric_codes(spec):
    return spec["num"] + spec.get("den", []) + spec.get("less", [])


# the metrics whose every code is in the list, in METRICS order
def available_metrics(codes):
    have = set(codes)
    return [name for name, spec in METRICS.items() if set(metric_codes(spec)) <= have]


# keep the key out of every message. requests puts the full url, query string
# included, into its own error text
def redact(text, key):
    return str(text).replace(key, "***") if key else str(text)


# the api spells a few names with accents. every file here stays ascii, so
# the accent goes and the letter stays
def ascii_text(text):
    return unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()


# the version the map shows for this source
def version_label(years=None):
    return "ACS 5-year " + ", ".join(str(year) for year in (years or VINTAGES))


# the codes a vintage carries. anything but 200 or 404 is an api problem
def present_variables(year, codes=None):
    present = []
    for code in codes or VARIABLES:
        response = fetch(VARIABLE_URL.format(year=year, code=code))
        if response.status_code == 200:
            present.append(code)
        elif response.status_code != 404:
            raise RuntimeError(f"census variable catalog answered HTTP {response.status_code} for {year} {code}")
    return present


# the api body is a json array whose first row is the header. a row of the
# wrong width is malformed and skipped
def parse_table(data, columns=None):
    if not data:
        return pd.DataFrame(columns=columns or [])
    header = list(data[0])
    rows = [row for row in data[1:] if len(row) == len(header)]
    return pd.DataFrame(rows, columns=header)


# one api call. a parent with no divisions in a vintage answers 204 with an
# empty body. a missing, unactivated or invalid key redirects to an html page
# that still says 200, so the content type is the proof this is data
def query(year, key, codes, geography, within=None):
    url = BASE_URL.format(year=year)
    params = {"get": ",".join(["NAME"] + list(codes)), "for": geography, "key": key}
    if within:
        params["in"] = within
    response = fetch(url, params=params)
    if response.status_code == 204 or not response.content.strip():
        return pd.DataFrame(columns=["NAME"] + list(codes) + [MSA_COL, DIV_COL])
    if response.status_code >= 400:
        raise RuntimeError(f"census answered HTTP {response.status_code} for {url} {geography}: "
                           f"{redact(response.text[:300], key)}")
    content_type = response.headers.get("content-type", "")
    if "json" not in content_type:
        raise RuntimeError(f"expected json from {url}, got {content_type}. usually a missing, "
                           "unactivated or invalid CENSUS_API_KEY")
    return parse_table(response.json())


# one vintage: every msa and micro, then the divisions of each split parent,
# tagged the way the pipeline's raw files are. geo_code is the join code, a
# division's own code crosswalked to its current one
def fetch_vintage(year, key, codes):
    frames = [tag_geography(query(year, key, codes, f"{MSA_COL}:*"), "msa")]
    for parent in DIVISION_PARENTS:
        divisions = query(year, key, codes, f"{DIV_COL}:*", within=f"{MSA_COL}:{parent}")
        frames.append(tag_geography(divisions, "division"))
    df = pd.concat(frames, ignore_index=True)
    df["year"] = year
    order = ["NAME"] + list(codes) + [MSA_COL, DIV_COL, "geo_level", "geo_code", "parent_cbsa", "year"]
    df = df.reindex(columns=order)
    df["NAME"] = df["NAME"].fillna("").map(ascii_text)
    return df


# the metrics for every row. a metric with a code the frame lacks is left out.
# a sentinel, a blank or a zero denominator makes the value missing, and a
# missing part of a sum makes the whole sum missing
def derive_metrics(df):
    values = pd.DataFrame(index=df.index)
    for code in VARIABLES:
        if code in df.columns:
            values[code] = pd.to_numeric(df[code], errors="coerce").astype(float)
    values = values.mask(values <= SENTINEL)
    out = pd.DataFrame(index=df.index)
    for name in available_metrics(values.columns):
        spec = METRICS[name]
        numerator = values[spec["num"]].sum(axis=1, skipna=False)
        if "den" not in spec:
            out[name] = numerator
            continue
        denominator = values[spec["den"]].sum(axis=1, skipna=False)
        if spec.get("less"):
            denominator = denominator - values[spec["less"]].sum(axis=1, skipna=False)
        out[name] = numerator / denominator.mask(denominator <= 0)
    return out


# the map contract rows for one vintage. a missing value has no row, a code
# that is not five digits is malformed and dropped, a code seen twice keeps
# its first row
def metric_rows(df, year):
    derived = derive_metrics(df)
    codes = df["geo_code"] if "geo_code" in df.columns else pd.Series("", index=df.index)
    derived.insert(0, "cbsa_code", codes.fillna("").astype(str).str.strip())
    long = derived.melt(id_vars="cbsa_code", var_name="metric", value_name="value")
    long = long.dropna(subset=["value"])
    long = long[long["cbsa_code"].str.fullmatch(r"\d{5}")]
    long["period"] = str(year)
    long["value"] = long["value"].astype(float).round(6)
    long = long.drop_duplicates(["cbsa_code", "metric"])
    return long.sort_values(["cbsa_code", "metric"], kind="stable")[COLUMNS].reset_index(drop=True)


# every vintage in one frame, one row per code, metric and period
def combine(frames):
    frames = [frame for frame in frames if len(frame)] or [pd.DataFrame(columns=COLUMNS)]
    df = pd.concat(frames, ignore_index=True).drop_duplicates(["cbsa_code", "metric", "period"])
    return df.sort_values(["cbsa_code", "metric", "period"], kind="stable")[COLUMNS].reset_index(drop=True)


def collect():
    key = env_key("CENSUS_API_KEY")
    if not key:
        raise RuntimeError("CENSUS_API_KEY is not set. signup: https://api.census.gov/data/key_signup.html")

    # every vintage's raw csv, the metrics table and the manifest land together.
    # a vintage that failed halfway used to leave the earlier ones replaced
    with staged_folder(OUT_DIR) as landing:
        entries, frames, absent = [], [], {}
        for year in VINTAGES:
            codes = present_variables(year)
            missing = [code for code in VARIABLES if code not in codes]
            if missing:
                absent[str(year)] = missing
                nulled = [name for name in METRICS if name not in available_metrics(codes)]
                print(f"[acs] {year} lacks {', '.join(missing)}, so {', '.join(nulled)} will be null")

            print(f"[acs] fetching {year}: every msa and micro plus the divisions of {len(DIVISION_PARENTS)} parents")
            raw = fetch_vintage(year, key, codes)
            path = landing.csv(raw, f"acs_extra_{year}.csv")
            rows = metric_rows(raw, year)
            frames.append(rows)
            entries.append(manifest_entry(
                path, BASE_URL.format(year=year), PROVIDER, f"ACS 5-year estimates, {year} vintage",
                f"ACS 5-year {year}", len(raw),
                {"geography": f"{MSA_COL}:* plus {DIV_COL}:* within {len(DIVISION_PARENTS)} split msas",
                 "variables": codes, "absent_variables": missing},
            ))
            divisions = int((raw["geo_level"] == "division").sum())
            print(f"[acs] {year}: {len(raw) - divisions} msas and micros, {divisions} divisions, "
                  f"{rows['metric'].nunique()} metrics -> {path.name}")

        metrics = combine(frames)
        out = landing.csv(metrics, OUT_FILE.name)
        entries.insert(0, manifest_entry(
            out, BASE_URL.format(year=VINTAGES[-1]), PROVIDER,
            "metro metrics derived from ACS 5-year estimates, one row per cbsa, metric and vintage",
            version_label(), len(metrics),
            {"metrics": METRICS, "vintages": VINTAGES, "division_crosswalk": DIVISION_CROSSWALK,
             "absent_variables": absent, "raw_files": [f"acs_extra_{year}.csv" for year in VINTAGES]},
        ))
        landing.manifest(entries)
    print(f"[acs] {len(metrics)} rows, {metrics['cbsa_code'].nunique()} codes, "
          f"{metrics['metric'].nunique()} metrics -> {OUT_FILE.name}")
    return OUT_FILE

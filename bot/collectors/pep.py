import io

import pandas as pd

from bot.common import RAW_DIR, fetch, manifest_entry, staged_folder, write_csv

OUT_DIR = RAW_DIR / "pep"
OUT_FILE = OUT_DIR / "metrics.csv"
BASE_URL = "https://www2.census.gov/programs-surveys/popest/datasets"
PROVIDER = "U.S. Census Bureau"

# the 2020 base series is tried newest first and the first vintage that
# answers is kept. the 2010 base series ended with vintage 2019
CURRENT_VINTAGES = (2025, 2024)
LEGACY_VINTAGE = 2019

COLUMNS = ["cbsa_code", "metric", "period", "value"]
DIVISION = "Metropolitan Division"
AREA_LSAD = {"Metropolitan Statistical Area", "Micropolitan Statistical Area", DIVISION}
REQUIRED = {"CBSA", "MDIV", "LSAD"}

# each metric with the column prefixes that carry it. the 2010 base file says
# NATURALINC where the 2020 base files say NATURALCHG
COMPONENTS = {
    "pop_estimate": ("POPESTIMATE",),
    "natural_change": ("NATURALCHG", "NATURALINC"),
    "domestic_migration": ("DOMESTICMIG",),
    "net_migration": ("NETMIG",),
}
RATE = "domestic_migration_rate"
METRICS = [*COMPONENTS, RATE]
BASE_PREFIX = "ESTIMATESBASE"


# every vintage sits in a folder named for the years it covers
def vintage_url(vintage):
    start = 2020 if vintage >= 2020 else 2010
    return f"{BASE_URL}/{start}-{vintage}/metro/totals/cbsa-est{vintage}-alldata.csv"


def empty():
    return pd.DataFrame({
        "cbsa_code": pd.Series(dtype=str), "metric": pd.Series(dtype=str),
        "period": pd.Series(dtype=str), "value": pd.Series(dtype=float),
    })


# the year of the estimates base column. its components cover april to june
# only, while its population estimate is a full july 1 value
def base_year(columns):
    for col in columns:
        suffix = col[len(BASE_PREFIX):]
        if col.startswith(BASE_PREFIX) and suffix.isdigit():
            return int(suffix)
    return None


# {year: column} for one metric, from the first prefix the file carries
def year_columns(columns, prefixes):
    for prefix in prefixes:
        found = {int(c[len(prefix):]): c for c in columns
                 if c.startswith(prefix) and c[len(prefix):].isdigit()}
        if found:
            return found
    return {}


# metro, micro and division rows keyed the way the map wants: a division by
# its MDIV, everything else by its CBSA. county rows and unlabelled rows go,
# a code seen twice keeps its first row
def area_rows(df):
    lsad = df["LSAD"].fillna("").str.strip()
    df = df[lsad.isin(AREA_LSAD)]
    division = lsad[df.index] == DIVISION
    code = df["CBSA"].where(~division, df["MDIV"]).fillna("").str.strip()
    df = df.assign(cbsa_code=code.str.zfill(5))[code.str.fullmatch(r"\d{1,5}")]
    return df.drop_duplicates("cbsa_code")


# domestic migration per thousand residents, where both sides exist and the
# population is positive
def migration_rate(long):
    keyed = long.set_index(["cbsa_code", "period"])
    pop = keyed[keyed["metric"] == "pop_estimate"]["value"].rename("pop")
    dom = keyed[keyed["metric"] == "domestic_migration"]["value"].rename("dom")
    both = pd.concat([pop, dom], axis=1, join="inner")
    both = both[both["pop"] > 0]
    return pd.DataFrame({
        "cbsa_code": both.index.get_level_values("cbsa_code"),
        "metric": RATE,
        "period": both.index.get_level_values("period"),
        "value": (both["dom"] * 1000 / both["pop"]).round(3).to_numpy(),
    }, columns=COLUMNS)


# one vintage file to long rows. takes the fetched latin-1 bytes or decoded
# text. the base year keeps its july 1 population estimate but not its
# components, which cover april to june of that year only
def parse_vintage(content):
    text = content.decode("latin-1") if isinstance(content, bytes) else content
    if not text.strip():
        return empty()
    df = pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False, on_bad_lines="skip")
    if not REQUIRED <= set(df.columns):
        raise ValueError(f"pep file is missing {sorted(REQUIRED - set(df.columns))}")
    areas = area_rows(df)
    skip = base_year(df.columns)
    frames = []
    for metric, prefixes in COMPONENTS.items():
        for year, col in sorted(year_columns(df.columns, prefixes).items()):
            if year == skip and metric != "pop_estimate":
                continue
            frames.append(pd.DataFrame({
                "cbsa_code": areas["cbsa_code"].to_numpy(),
                "metric": metric,
                "period": str(year),
                "value": pd.to_numeric(areas[col], errors="coerce").to_numpy(),
            }, columns=COLUMNS))
    long = pd.concat(frames, ignore_index=True) if frames else empty()
    long = long.dropna(subset=["value"])
    return pd.concat([long, migration_rate(long)], ignore_index=True)


# frames keyed by vintage, stacked oldest first so the newest wins a shared year
def merge_vintages(frames):
    ordered = [frames[vintage] for vintage in sorted(frames)]
    if not ordered:
        return empty()
    merged = pd.concat(ordered, ignore_index=True)
    merged = merged.drop_duplicates(["cbsa_code", "metric", "period"], keep="last")
    return merged.sort_values(["cbsa_code", "metric", "period"]).reset_index(drop=True)


# counts stay whole numbers on disk, the rate keeps its decimals
def write_metrics(df, path):
    write_csv(df[COLUMNS], path, float_format="%.10g")
    return path


def _filename(url):
    return url.rsplit("/", 1)[-1]


def _fetch_vintage(vintage):
    url = vintage_url(vintage)
    print(f"[pep] fetching vintage {vintage} {_filename(url)}")
    return url, fetch(url)


# the newest 2020 base vintage that answers, then the final 2010 base vintage
def download():
    files = {}
    for vintage in CURRENT_VINTAGES:
        url, response = _fetch_vintage(vintage)
        if response.ok:
            files[vintage] = (url, response.content)
            break
        print(f"[pep] vintage {vintage} not published, HTTP {response.status_code}")
    if not files:
        raise RuntimeError("no 2020 base vintage answered")
    url, response = _fetch_vintage(LEGACY_VINTAGE)
    response.raise_for_status()
    files[LEGACY_VINTAGE] = (url, response.content)
    return files


def collect():
    files = download()
    # every vintage's raw file, the metrics table and the manifest land together
    with staged_folder(OUT_DIR) as landing:
        frames, entries = {}, []
        for vintage in sorted(files, reverse=True):
            url, content = files[vintage]
            raw = landing.bytes(_filename(url), content)
            frames[vintage] = parse_vintage(content)
            years = sorted(frames[vintage]["period"].unique())
            entries.append(manifest_entry(
                raw, url, PROVIDER,
                f"Population Estimates Program vintage {vintage}, metropolitan and micropolitan "
                "statistical area totals with components of change",
                f"vintage {vintage}, {years[0]} to {years[-1]}", len(content.splitlines()) - 1,
                {"encoding": "latin-1", "area_codes": int(frames[vintage]["cbsa_code"].nunique())},
            ))

        df = merge_vintages(frames)
        metrics_path = write_metrics(df, landing.path(OUT_FILE.name))
        years = sorted(df["period"].unique())
        newest = max(files)
        entries.insert(0, manifest_entry(
            metrics_path, files[newest][0], PROVIDER,
            "Population Estimates Program metro, micro and division totals with components of change, "
            "one row per area, metric and year",
            f"vintage {newest}, annual {years[0]} to {years[-1]}", len(df),
            {
                "metrics": METRICS,
                "vintages": {str(vintage): files[vintage][0] for vintage in sorted(files)},
                "base_years": "the population estimate is kept, the components are skipped "
                              "because they cover april to june of that year only",
                "rate": "domestic_migration_rate is domestic_migration per 1,000 of pop_estimate",
            },
        ))
        landing.manifest(entries)
    # a superseded vintage saved by an earlier run has no place beside the new
    # one, and is dropped only once the new one has landed
    kept = {_filename(url) for url, _ in files.values()}
    for stale in OUT_DIR.glob("cbsa-est*-alldata.csv"):
        if stale.name not in kept:
            stale.unlink()

    print(f"[pep] {len(df)} rows for {df['cbsa_code'].nunique()} codes, "
          f"{years[0]} to {years[-1]} -> {OUT_FILE.name}")
    return OUT_FILE

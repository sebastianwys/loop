import json
import re
from pathlib import Path

import pandas as pd

from bot import indicators
from bot.collectors.gazetteer import YEAR as GAZETTEER_YEAR
from bot.common import BASE_DIR, INTEGRATED, RAW_DIR, STUDY_YEARS, WEB_DATA_DIR, unchanged_but_for_stamps, utc_now

DEFAULT_PATHS = {
    "enrichment_dir": RAW_DIR,
    "forecast_dir": BASE_DIR / "ml" / "results" / "forecast",
    "merged": INTEGRATED,
    "centroids": RAW_DIR / "gazetteer" / "cbsa_centroids.csv",
    "zhvi": RAW_DIR / "zillow" / "zhvi_metro.csv",
    "zori": RAW_DIR / "zillow" / "zori_metro.csv",
    "bls": RAW_DIR / "bls" / "laus_metro_unemployment.csv",
    "fred": RAW_DIR / "fred" / "mortgage30us.csv",
    "national": RAW_DIR / "national" / "indicators.csv",
    "fhfa": RAW_DIR / "fhfa" / "hpi_master.csv",
}

# fhfa's metro series begin in 1975, so the panel draws the whole history, one
# annual mean of the quarterly index per year, the last year partial. this is
# the floor, not every metro's start: fhfa phased most of them in later and each
# one begins at its own first drawable year
SERIES_START = 1975

# sources whose files are read straight into the build rather than discovered
# as a metrics.csv, so they need naming for the vintage line by hand
DIRECT_SOURCES = ("fhfa", "census")

# zillow monthly columns look like 2024-01-31
MONTH = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# census marks a missing estimate with a large negative sentinel
SENTINEL = -666666

NUMERIC = [
    "year", "avg_index_nsa", "median_income", "total_pop", "median_age",
    "bachelors_count", "masters_count", "total_occupied_units",
    "owner_occupied_units", "median_home_value", "homeownership_rate",
]


def missing(value):
    return value is None or pd.isna(value)


# none stays none, everything else becomes a rounded python float
def rnd(value, digits):
    return None if missing(value) else round(float(value), digits)


def as_int(value):
    return None if missing(value) else int(round(float(value)))


# the state lists in an acs name, the MD-DE in "Salisbury, MD-DE Metro Area".
# a division name carries two, its own and its parent's, so both are returned
STATE_LIST = re.compile(r",\s*([A-Z]{2}(?:-[A-Z]{2})*)[\s;]")


def name_states(name):
    return None if missing(name) else STATE_LIST.findall(f"{name} ")


# "2026Q2" as the quarter's end month, "2026-06", which is how every other
# latest date in the contract reads
def quarter_end_month(as_of):
    m = re.fullmatch(r"(\d{4})Q([1-4])", str(as_of or ""))
    return None if not m else f"{m.group(1)}-{int(m.group(2)) * 3:02d}"


# (later - earlier) / earlier. none if either side is missing or earlier is 0
def growth(later, earlier):
    if missing(later) or missing(earlier) or earlier == 0:
        return None
    return (later - earlier) / earlier


def ratio(numerator, denominator):
    if missing(numerator) or missing(denominator) or denominator == 0:
        return None
    return numerator / denominator


# --- loaders ---

def load_merged(path):
    df = pd.read_csv(path, dtype={"cbsa_code": str, "place_id": str, "geo_level": str, "parent_cbsa": str})
    for col in NUMERIC:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
            df[col] = df[col].mask(df[col] <= SENTINEL)
    return df


def load_centroids(path):
    df = pd.read_csv(path, dtype={"cbsa_code": str})
    return df.drop_duplicates("cbsa_code").set_index("cbsa_code")


# one row per metro indexed by zillow's own name, monthly columns only
def load_zillow(path):
    df = pd.read_csv(path)
    df = df[df["RegionType"] != "country"]
    df = df[~df["RegionName"].duplicated()].set_index("RegionName")
    months = [c for c in df.columns if MONTH.match(c)]
    return df[months].apply(pd.to_numeric, errors="coerce")


def load_bls(path):
    df = pd.read_csv(path, dtype={"cbsa_code": str, "period": str})
    df["year"] = pd.to_numeric(df["year"], errors="coerce").astype(int)
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df


# the fhfa master file holds every quarter since 1975 for every metro and
# division. keep the one series the pipeline uses, average it by year from the
# metro's own first quarter and remember the last quarter, so the panel can
# label the partial year. anchor is that quarter's own level, the base the
# model measured its forecast growth from
def load_fhfa_series(path):
    df = pd.read_csv(path, dtype={"place_id": str, "yr": str, "period": str}, usecols=[
        "hpi_type", "hpi_flavor", "frequency", "level", "place_id", "yr", "period", "index_nsa"])
    keep = (df["level"] == "MSA") & (df["frequency"] == "quarterly") & (df["hpi_type"] == "traditional") & (df["hpi_flavor"] == "all-transactions")
    df = df[keep].copy()
    df["yr"] = pd.to_numeric(df["yr"], errors="coerce")
    df["period"] = pd.to_numeric(df["period"], errors="coerce")
    df["index_nsa"] = pd.to_numeric(df["index_nsa"], errors="coerce")
    df = df.dropna(subset=["yr", "period", "index_nsa"])
    df = df[df["yr"] >= SERIES_START]
    series = {}
    for code, group in df.groupby("place_id"):
        annual = group.groupby("yr")["index_nsa"].mean()
        quarters = group.groupby("yr")["index_nsa"].size()
        first_year, last_year = int(annual.index.min()), int(annual.index.max())
        newest = group.sort_values(["yr", "period"]).iloc[-1]
        anchor = rnd(newest["index_nsa"], 2)

        # a year is an annual mean only with all four quarters in. the newest
        # year is short most of the time, so it carries the index at as_of
        # instead, which is the level the forecast grows from. a short year
        # inside the history has no annual mean and is drawn as the gap it is
        values = []
        for year in range(first_year, last_year + 1):
            if quarters.get(year, 0) >= 4:
                values.append(rnd(annual.get(year), 1))
            elif year == last_year:
                values.append(anchor)
            else:
                values.append(None)

        # fhfa phases a metro in mid year, so the first year is often short and
        # has no mean to draw. that is empty margin at the left of the panel
        # rather than a gap in a line, so the series starts at its first value
        drawn = next((i for i, value in enumerate(values) if value is not None), 0)

        partial = last_year if quarters.get(last_year, 0) < 4 else None
        series[str(code)] = {"start": first_year + drawn, "values": values[drawn:],
                             "as_of": f"{int(newest['yr'])}Q{int(newest['period'])}",
                             "anchor": anchor, "partial_year": partial}
    return series


def load_fred(path):
    df = pd.read_csv(path, dtype={"date": str})
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df


# one row per series and observation, written by bot/collectors/national.py
def load_national(path):
    df = pd.read_csv(path, dtype={"series_id": str, "date": str})
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df


# --- zillow ---

# fhfa says "Chicago-Naperville-Elgin, IL-IN-WI", zillow says "Chicago, IL".
# exact name first, then first city, then first two cities
def zillow_candidates(place_name):
    if "," not in place_name:
        return [place_name]
    cities, states = [part.strip() for part in place_name.split(",", 1)]
    state_tokens = states.replace("-", " ").split()
    first_state = state_tokens[0] if state_tokens else ""
    # "/" separates a city from its county name, as in louisville/jefferson county
    parts = [part.strip() for part in cities.replace("/", "-").split("-")]
    candidates = [place_name, f"{parts[0]}, {first_state}"]
    if len(parts) > 1:
        candidates.append(f"{parts[0]}-{parts[1]}, {first_state}")
    # zillow sometimes names a metro by a later city, "The Villages, FL" for
    # "Wildwood-The Villages, FL". first city stays preferred by order
    candidates += [f"{part}, {first_state}" for part in parts[1:]]
    return list(dict.fromkeys(candidates))


# fhfa marks divisions with a suffix the map does not need
def display_name(place_name):
    return re.sub(r"\s*\(MSAD\)$", "", str(place_name)).strip()


# the parent metro of a division, named without the census suffix
def parent_info(parent_code, centroids):
    code = None if missing(parent_code) else str(parent_code).strip()
    if not code or code not in centroids.index:
        return None
    name = re.sub(r"\s*(Metro|Micro) Area$", "", str(centroids.loc[code]["name"]))
    return {"cbsa": code, "name": name}


def match_zillow(place_name, frame):
    if frame is None or place_name is None:
        return None
    for candidate in zillow_candidates(place_name):
        if candidate in frame.index:
            return frame.loc[candidate]
    return None


# mean of the non-null months in one year
def zillow_annual(row, year):
    if row is None:
        return None
    values = row[[c for c in row.index if c.startswith(f"{year}-")]].dropna()
    return float(values.mean()) if len(values) else None


# last non-null month and its date
def zillow_latest(row):
    if row is None:
        return None, None
    values = row.dropna()
    if not len(values):
        return None, None
    return float(values.iloc[-1]), str(values.index[-1])


# --- bls ---

# annual average is period m13
def bls_year(frame, cbsa, year):
    if frame is None:
        return None
    rows = frame[(frame["cbsa_code"] == cbsa) & (frame["period"] == "M13") & (frame["year"] == year)]
    values = rows["value"].dropna()
    return float(values.iloc[0]) if len(values) else None


# newest monthly row, date as yyyy-mm
def bls_latest(frame, cbsa):
    if frame is None:
        return None, None
    rows = frame[(frame["cbsa_code"] == cbsa) & (frame["period"] != "M13")].dropna(subset=["value"])
    if not len(rows):
        return None, None
    newest = rows.sort_values(["year", "period"]).iloc[-1]
    return float(newest["value"]), f"{int(newest['year'])}-{str(newest['period'])[1:]}"


# --- fred ---

def fred_annual(frame, year):
    if frame is None:
        return None
    values = frame[frame["date"].str.startswith(str(year))]["value"].dropna()
    return float(values.mean()) if len(values) else None


def fred_latest(frame):
    if frame is None:
        return None, None
    rows = frame.dropna(subset=["value"])
    if not len(rows):
        return None, None
    last = rows.iloc[-1]
    return float(last["value"]), str(last["date"])


# --- national indicators ---

# the dashboard strip. bot/indicators.py names the tiles, this turns the
# collector's csv into one record per tile in that order

# round() hands back -0.0 for a small negative, which json prints as -0.0.
# adding zero folds it onto plain zero
def rnd_zero(value, digits):
    return round(float(value), digits) + 0.0


# one number per calendar month per series, keyed yyyy-mm. the last observation
# of a month wins, and a month with nothing but missing values has no key
def monthly_grid(frame):
    grid = {}
    rows = frame.dropna(subset=["value"]).sort_values("date")
    for series_id, group in rows.groupby("series_id"):
        grid[str(series_id)] = {str(d)[:7]: float(v) for d, v in zip(group["date"], group["value"])}
    return grid


# the yyyy-mm that many months earlier
def month_back(month, count):
    index = int(month[:4]) * 12 + int(month[5:7]) - 1 - count
    return f"{index // 12:04d}-{index % 12 + 1:02d}"


# a rounded difference, none when either side is missing
def diff(later, earlier, digits=1):
    if missing(later) or missing(earlier):
        return None
    return rnd_zero(later - earlier, digits)


# the tile's own number for every month it can be made for. a month it cannot
# be made for is left out, never filled from a nearer one
def indicator_months(spec, grid):
    months = grid.get(spec["series"]) or {}
    kind = spec["transform"]
    if kind == "level":
        return dict(months)
    if kind == "yoy":
        out = {}
        for month, value in months.items():
            base = months.get(month_back(month, 12))
            # a hole twelve months back, or a zero base, drops the month
            if base:
                out[month] = rnd_zero(100.0 * (value / base - 1.0), 1)
        return out
    if kind == "spread":
        against = grid.get(spec.get("against")) or {}
        # both sides publish two decimals, so the difference keeps two
        return {m: rnd_zero(v - against[m], 2) for m, v in months.items() if m in against}
    raise ValueError(f"{spec['id']}: unknown transform {kind}")


# value and date are the newest month with a number, history is the last
# HISTORY_MONTHS of them, oldest first
def indicator_record(spec, months):
    dates = sorted(months)
    newest = dates[-1]
    value = months[newest]
    return {
        "id": spec["id"],
        "label": spec["label"],
        "group": spec["group"],
        "format": spec["format"],
        "provider": spec["provider"],
        "note": spec["note"],
        "value": value,
        "date": newest,
        "change_12m": diff(value, months.get(month_back(newest, 12))),
        # the transform already rounded to the precision the tile publishes, so
        # the chart carries the tile's own number. rounding again here put the
        # fed funds tile at 3.75 and the line beside it at 3.8
        "history": [{"date": m, "value": months[m]} for m in dates[-indicators.HISTORY_MONTHS:]],
    }


# an indicator the csv cannot make a single month for is left out rather than
# shown as a row of nulls
def indicator_list(frame):
    grid = monthly_grid(frame)
    records, skipped = [], []
    for spec in indicators.INDICATORS:
        months = indicator_months(spec, grid)
        if months:
            records.append(indicator_record(spec, months))
        else:
            skipped.append(spec["id"])
    if skipped:
        print(f"[build] national indicators with no data, skipped: {', '.join(skipped)}")
    return records


# the newest observation date in the file, the age of the whole strip
def indicators_updated(frame):
    dates = frame.dropna(subset=["value"])["date"]
    return str(dates.max()) if len(dates) else None


# --- generic enrichment ---

ENRICHMENT_COLUMNS = ["cbsa_code", "metric", "period", "value"]
# the file name the metrics contract is written under, in every source folder
ENRICHMENT_FILE = "metrics.csv"

# core field names a collector may not reuse
RESERVED = {"hpi", "income", "pop", "age", "degree_share", "own_rate", "home_value", "zhvi", "zori", "unemp"}


# any collector can drop metrics.csv beside its manifest with the columns
# cbsa_code, metric, period, value. period is yyyy for an annual value or
# yyyy-mm for a monthly one. annual values land in years[y], the newest period
# per metric lands in latest with its date. the folder names the source
def load_enrichment(path):
    path = Path(path)
    df = pd.read_csv(path, dtype={"cbsa_code": str, "metric": str, "period": str})
    absent = [c for c in ENRICHMENT_COLUMNS if c not in df.columns]
    if absent:
        raise ValueError(f"{path.parent.name}/metrics.csv is missing columns {absent}")
    clash = sorted(set(df["metric"].dropna()) & RESERVED)
    if clash:
        raise ValueError(f"{path.parent.name}/metrics.csv reuses core field names {clash}")
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df = df.dropna(subset=["cbsa_code", "metric", "period", "value"])
    return {
        "name": path.parent.name,
        "folder": path.parent,
        "metrics": sorted(df["metric"].unique()),
        "groups": {code: sub for code, sub in df.groupby("cbsa_code")},
    }


# the raw folder holds one subfolder per collector. any extra path is a source
# folder on its own, the model's export under ml/results, skipped until it exists
def discover_enrichments(raw_dir, *folders):
    files = sorted(Path(raw_dir).glob(f"*/{ENRICHMENT_FILE}"))
    files += [Path(f) / ENRICHMENT_FILE for f in folders if (Path(f) / ENRICHMENT_FILE).exists()]
    return [load_enrichment(p) for p in files]


# the version string from a source's manifest, for the sources block
# a collector that rolls several downloads into one metrics.csv writes that
# file's entry first and describes the whole folder in its version. a folder
# with no such rollup holds peer files instead, and taking the first of them
# named one census vintage of three and one gazetteer file of two
def folder_version(entries):
    for entry in entries:
        if entry.get("filename") == ENRICHMENT_FILE:
            return entry.get("version", "present")
    seen = [e.get("version") for e in entries if e.get("version")]
    distinct = list(dict.fromkeys(seen))
    return ", ".join(distinct) if distinct else "present"


# the vintage line for the sources that are read straight into the build. a
# folder that is not on disk is left out rather than listed as present, because
# the line is what the site shows a reader as proof the source was fetched
def direct_versions(raw_dir):
    out = {}
    for name in DIRECT_SOURCES:
        folder = Path(raw_dir) / name
        if (folder / "download_manifest.json").exists():
            out[name] = enrichment_version(folder)
    return out


def enrichment_version(folder):
    manifest = Path(folder) / "download_manifest.json"
    if not manifest.exists():
        return "present"
    entries = json.loads(manifest.read_text())
    return folder_version(entries) if entries else "present"


# annual values keyed (metric, year), plus the newest period per metric
def enrich_values(rows):
    annual, latest = {}, {}
    if rows is None:
        return annual, latest
    for metric, period, value in zip(rows["metric"], rows["period"], rows["value"]):
        period = str(period)
        if len(period) == 4 and period.isdigit():
            annual[(metric, int(period))] = float(value)
        if metric not in latest or period > latest[metric][0]:
            latest[metric] = (period, float(value))
    return annual, latest


def _has(metric, annual, latest):
    return metric in latest or any(m == metric for m, _ in annual)


# fold every enrichment into one metro. a division with no rows of its own for
# a metric takes the parent's and lists the metric in parent_metrics. every
# metro gets every metric key, null when nothing is known
def apply_enrichments(metro, enrichments, parent_code=None):
    inherited = []
    for source in enrichments:
        own = enrich_values(source["groups"].get(metro["cbsa"]))
        parent = enrich_values(source["groups"].get(parent_code)) if parent_code else ({}, {})
        for metric in source["metrics"]:
            annual, latest = own
            if not _has(metric, *own) and _has(metric, *parent):
                annual, latest = parent
                inherited.append(metric)
            for year in STUDY_YEARS:
                metro["years"][str(year)][metric] = rnd(annual.get((metric, year)), 4)
            period, value = latest.get(metric, (None, None))
            metro["latest"][metric] = rnd(value, 4)
            metro["latest"][f"{metric}_date"] = period
    metro["parent_metrics"] = sorted(inherited)
    return metro


# --- provenance ---

# one line per source folder rather than one per file: the first manifest entry
# is the file the folder is named for, the one the build reads, and the rest are
# totalled into files and row_count instead of being copied out whole. a
# manifest that is missing, unreadable, or that cannot say where the bytes came
# from proves nothing, so its folder is left out rather than failing the build
def provenance_entry(manifest):
    manifest = Path(manifest)
    try:
        entries = json.loads(manifest.read_text())
    except (OSError, ValueError):
        entries = None
    if not isinstance(entries, list) or not entries or not all(isinstance(e, dict) for e in entries):
        return None
    first = entries[0]
    integrity = first.get("integrity") or {}
    source = first.get("source") or {}
    # collectors that hit an api write endpoint, the ones that pull a file write url
    url = source.get("url") or source.get("endpoint")
    if not url:
        return None
    rows = [(e.get("integrity") or {}).get("row_count") for e in entries]
    rows = [r for r in rows if isinstance(r, int)]
    stamps = [e["downloaded_at"] for e in entries if e.get("downloaded_at")]
    return {
        "source": manifest.parent.name,
        "provider": source.get("provider"),
        "url": url,
        "version": first.get("version"),
        # the folder is as old as its newest download
        "downloaded_at": max(stamps) if stamps else None,
        "files": len(entries),
        "row_count": sum(rows) if rows else None,
        # the hash belongs to one file, so the file is named beside it
        "filename": first.get("filename"),
        "sha256": integrity.get("sha256"),
    }


# what makes the pipeline checkable from the site: every raw folder, where it
# came from, which version it was and the hash it had when it landed
def provenance_block(raw_dir):
    block = []
    for manifest in sorted(Path(raw_dir).glob("*/download_manifest.json")):
        entry = provenance_entry(manifest)
        if entry is None:
            print(f"[build] {manifest.parent.name} has no usable download manifest, left out of provenance")
            continue
        block.append(entry)
    return block


# --- assembly ---

def year_record(row, zhvi_row, zori_row, bls_frame, cbsa, year):
    get = (lambda col: None) if row is None else (lambda col: row.get(col))
    pop = get("total_pop")
    bachelors, masters = get("bachelors_count"), get("masters_count")
    # b15003 counts within adults 25 and over, so that is the denominator. over
    # total population the share reads about a third low, and by a different
    # amount per metro, because the share of adults varies from 62 to 71 percent
    degree = None if missing(bachelors) or missing(masters) else ratio(bachelors + masters, get("adults_25_plus"))
    own_rate = get("homeownership_rate")
    if missing(own_rate):
        own_rate = ratio(get("owner_occupied_units"), get("total_occupied_units"))
    return {
        "hpi": rnd(get("avg_index_nsa"), 2),
        "income": rnd(get("median_income"), 1),
        "pop": as_int(pop),
        "age": rnd(get("median_age"), 1),
        "degree_share": rnd(degree, 4),
        "own_rate": rnd(own_rate, 4),
        "home_value": rnd(get("median_home_value"), 1),
        "zhvi": rnd(zillow_annual(zhvi_row, year), 1),
        "zori": rnd(zillow_annual(zori_row, year), 1),
        "unemp": rnd(bls_year(bls_frame, cbsa, year), 1),
    }


def build_metros(merged, centroids, zhvi=None, zori=None, bls_frame=None, enrichments=(), series=None):
    metros, dropped, unmatched = [], 0, 0
    y0, y1, y2 = STUDY_YEARS
    for cbsa, group in merged.groupby("cbsa_code", sort=False):
        if cbsa not in centroids.index:
            dropped += 1
            continue
        name = display_name(group["place_name"].iloc[0])
        centroid = centroids.loc[cbsa]
        rows = {int(r["year"]): r for _, r in group.iterrows()}

        first = group.iloc[0]
        level = "division" if str(first.get("geo_level", "")) == "division" else "msa"
        parent = parent_info(first.get("parent_cbsa"), centroids) if level == "division" else None

        # zillow publishes metros, not divisions, so a division carries its
        # parent's values and says so. a division with no parent gets nothing,
        # since "Boston, MA" the division would otherwise match the metro silently
        zillow_name = parent["name"] if parent else (name if level == "msa" else None)
        zhvi_row = match_zillow(zillow_name, zhvi)
        zori_row = match_zillow(zillow_name, zori)
        # scope covers every zillow series, so one matched series is enough to
        # label the row. keying it on zhvi alone hid an inherited rent
        matched_zillow = zhvi_row is not None or zori_row is not None
        zillow_scope = ("parent metro" if parent else "metro") if matched_zillow else None
        if zhvi is not None and zhvi_row is None:
            unmatched += 1

        def value(year, col):
            row = rows.get(year)
            return None if row is None else row.get(col)

        # a vintage pair that gains or loses a state is a redrawn cbsa and has no
        # growth rate to report. the full name is too loose a test: omb renames the
        # principal cities without moving a county line, so bakersfield becomes
        # bakersfield-delano on the same kern county and austin gains san marcos
        # from a county it already had. the state list moves only with the
        # counties. hpi is left alone, fhfa restates its series on one delineation
        def acs_growth(later_year, earlier_year, col):
            later_states = name_states(value(later_year, "NAME"))
            earlier_states = name_states(value(earlier_year, "NAME"))
            if later_states and earlier_states and later_states != earlier_states:
                return None
            return growth(value(later_year, col), value(earlier_year, col))

        hpi_series = series.get(cbsa) if series else None
        zhvi_latest, zhvi_date = zillow_latest(zhvi_row)
        zori_latest, zori_date = zillow_latest(zori_row)
        unemp_latest, unemp_date = bls_latest(bls_frame, cbsa)

        record = {
            "cbsa": cbsa,
            "name": name,
            "level": level,
            "parent": parent,
            "zillow_scope": zillow_scope,
            "lat": float(centroid["lat"]),
            "lon": float(centroid["lon"]),
            "years": {str(y): year_record(rows.get(y), zhvi_row, zori_row, bls_frame, cbsa, y) for y in STUDY_YEARS},
            "latest": {
                "zhvi": rnd(zhvi_latest, 1), "zhvi_date": zhvi_date,
                "zori": rnd(zori_latest, 1), "zori_date": zori_date,
                "unemp": rnd(unemp_latest, 1), "unemp_date": unemp_date,
                # the headline index reads the newest fhfa quarter. the
                # 2014/2019/2024 vintage averages keep their year panels
                "hpi": hpi_series.get("anchor") if hpi_series else None,
                "hpi_date": quarter_end_month(hpi_series.get("as_of")) if hpi_series else None,
            },
            "growth": {
                f"hpi_{y0 % 100}_{y1 % 100}": rnd(growth(value(y1, "avg_index_nsa"), value(y0, "avg_index_nsa")), 4),
                f"hpi_{y1 % 100}_{y2 % 100}": rnd(growth(value(y2, "avg_index_nsa"), value(y1, "avg_index_nsa")), 4),
                f"income_{y0 % 100}_{y2 % 100}": rnd(acs_growth(y2, y0, "median_income"), 4),
                f"pop_{y0 % 100}_{y2 % 100}": rnd(acs_growth(y2, y0, "total_pop"), 4),
                f"home_value_{y0 % 100}_{y2 % 100}": rnd(acs_growth(y2, y0, "median_home_value"), 4),
            },
            "ptir": {str(y): rnd(ratio(value(y, "median_home_value"), value(y, "median_income")), 4) for y in STUDY_YEARS},
        }
        if hpi_series:
            record["series"] = {"hpi": hpi_series}
        metros.append(apply_enrichments(record, enrichments, parent["cbsa"] if parent else None))

    metros.sort(key=lambda m: m["name"])
    return metros, dropped, unmatched


def zillow_version(frame):
    return None if frame is None or not len(frame.columns) else f"through {frame.columns[-1]}"


def bls_version(frame):
    return None if frame is None or not len(frame) else f"{int(frame['year'].min())} onward"


def fred_version(frame):
    _, date = fred_latest(frame)
    return None if date is None else f"through {date}"


# the mortgage rate tile and the indicator strip share the block. either
# input can be absent, and the block is dropped only when both are
def national_block(fred_frame, national_frame=None):
    block = {}
    if fred_frame is not None:
        latest, date = fred_latest(fred_frame)
        rate = {str(y): rnd(fred_annual(fred_frame, y), 2) for y in STUDY_YEARS}
        rate["latest"] = rnd(latest, 2)
        rate["latest_date"] = date
        block["mortgage_rate"] = rate
    if national_frame is not None:
        block["indicators_updated"] = indicators_updated(national_frame)
        block["indicators"] = indicator_list(national_frame)
    return block or None


# a source is optional on a first build and mandatory on every one after. the
# zillow csvs are gitignored, so a checkout that has not run that collector
# cannot see them, and a partial rebuild would write nulls over every zhvi and
# zori in the file. fail instead, and name what went missing
def refuse_to_lose_a_source(out_path, payload):
    if not Path(out_path).exists():
        return
    try:
        previous = json.loads(Path(out_path).read_text())
    except ValueError:
        return
    had = {name for name, version in (previous.get("sources") or {}).items() if version}
    has = {name for name, version in (payload.get("sources") or {}).items() if version}
    lost = sorted(had - has)
    if lost:
        raise RuntimeError(
            f"{out_path.name} already carries {lost} and this build cannot see "
            "them, so writing would blank those columns. run those collectors "
            "first, or build somewhere else"
        )


# optional inputs come back as none with a note instead of failing the build
def optional(path, loader, label):
    path = Path(path)
    if not path.exists():
        print(f"[build] {label} not found at {path.name}, its fields will be null")
        return None
    return loader(path)


def build(out_path=None, paths=None):
    p = dict(DEFAULT_PATHS)
    if paths:
        p.update(paths)

    merged = load_merged(p["merged"])
    centroids = load_centroids(p["centroids"])
    zhvi = optional(p["zhvi"], load_zillow, "zillow zhvi")
    zori = optional(p["zori"], load_zillow, "zillow zori")
    bls_frame = optional(p["bls"], load_bls, "bls")
    fred_frame = optional(p["fred"], load_fred, "fred")
    national_frame = optional(p["national"], load_national, "national indicators")
    fhfa_series = optional(p["fhfa"], load_fhfa_series, "fhfa history")
    enrichments = discover_enrichments(p["enrichment_dir"], p["forecast_dir"])

    metros, dropped, unmatched = build_metros(merged, centroids, zhvi, zori, bls_frame, enrichments, fhfa_series)

    payload = {
        "generated_at": utc_now(),
        "years": list(STUDY_YEARS),
        "sources": {
            "gazetteer": f"{GAZETTEER_YEAR} Gazetteer",
            "zillow": zillow_version(zhvi),
            "bls": bls_version(bls_frame),
            "fred": fred_version(fred_frame),
            # fhfa and census are not enrichment folders, they feed the merged
            # csv and the price series directly, so the discovery loop below
            # never reached them and the footer's vintage line silently omitted
            # the two sources the whole map is built on
            **direct_versions(p["enrichment_dir"]),
            **{e["name"]: enrichment_version(e["folder"]) for e in enrichments},
        },
        "provenance": provenance_block(p["enrichment_dir"]),
        "national": national_block(fred_frame, national_frame),
        "metros": metros,
    }

    out_path = Path(out_path) if out_path else WEB_DATA_DIR / "metros.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    refuse_to_lose_a_source(out_path, payload)
    # the daily national refresh rebuilds this whether or not fred moved, so a
    # rebuild that lands on the same numbers leaves the file exactly as it was
    if not unchanged_but_for_stamps(out_path, payload):
        out_path.write_text(json.dumps(payload, ensure_ascii=True, allow_nan=False) + "\n")

    print(f"[build] {len(metros)} metros, {dropped} without a centroid dropped, "
          f"{unmatched} without a zillow match, {len(enrichments)} enrichment sources "
          f"-> {out_path.name} ({out_path.stat().st_size / 1024:.0f} KB)")
    return out_path


if __name__ == "__main__":
    build()

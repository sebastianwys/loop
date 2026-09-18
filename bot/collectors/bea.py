import copy
import datetime
import json
import math
import re
import time

import pandas as pd

from bot.collectors import irs
from bot.common import RAW_DIR, env_key, fetch, manifest_entry, write_manifest

OUT_DIR = RAW_DIR / "bea"
ENDPOINT = "https://apps.bea.gov/api/data"
PROVIDER = "U.S. Bureau of Economic Analysis"
DATASET = "Regional"
TABLE = "CAINC1"
FIRST_YEAR = 2014
# bea asks for no more than one request a second
PAUSE_SECONDS = 1.0
# the code bea answers for a year it has not published yet
NOT_PUBLISHED = "101"

# the cainc1 lines pulled for every county, with the unit and power of ten
# each must report. per capita is derived from the two, so line 3 stays out
LINES = {
    "1": {"metric": "bea_personal_income", "unit": "Thousands of dollars", "unit_mult": "3"},
    "2": {"metric": "bea_population", "unit": "Number of persons", "unit_mult": "0"},
}
INCOME = LINES["1"]["metric"]
POPULATION = LINES["2"]["metric"]
PER_CAPITA = "bea_income_per_capita"
SUMMED = [INCOME, POPULATION]
METRICS = SUMMED + [PER_CAPITA]
COLUMNS = ["cbsa_code", "metric", "period", "value"]
COUNTY_COLUMNS = ["county_fips", "period", "value"]
FIPS = re.compile(r"\d{5}")
YEAR = re.compile(r"\d{4}")

# bea reports each of these groups of a virginia county with its independent
# cities, and maui with kalawao, under one code of its own and publishes no
# separate estimates for the parts. every part sits in the same cbsa and
# division in the july 2023 delineation, so the code takes the parts' codes
COMBINED = {
    "15901": ["15005", "15009"],
    "51901": ["51003", "51540"],
    "51903": ["51005", "51580"],
    "51907": ["51015", "51790", "51820"],
    "51911": ["51031", "51680"],
    "51913": ["51035", "51640"],
    "51918": ["51053", "51570", "51730"],
    "51919": ["51059", "51600", "51610"],
    "51921": ["51069", "51840"],
    "51923": ["51081", "51595"],
    "51929": ["51089", "51690"],
    "51931": ["51095", "51830"],
    "51933": ["51121", "51750"],
    "51939": ["51143", "51590"],
    "51941": ["51149", "51670"],
    "51942": ["51153", "51683", "51685"],
    "51944": ["51161", "51775"],
    "51945": ["51163", "51530", "51678"],
    "51947": ["51165", "51660"],
    "51949": ["51175", "51620"],
    "51951": ["51177", "51630"],
    "51953": ["51191", "51520"],
    "51955": ["51195", "51720"],
    "51958": ["51199", "51735"],
}

# connecticut replaced its counties with planning regions in 2022. bea
# publishes the counties through 2023 and the regions from 2024, while the
# delineation names the regions alone, so a county row joins nothing and a
# connecticut metro arrives with its newest year only. each county takes the
# code of the region that succeeded it, the one holding most of its towns.
# the two sides never carry a value in the same year: bea writes 0 for the
# side it did not estimate and parse_counties drops it
CONNECTICUT = {
    "09001": "09190",  # fairfield, western connecticut
    "09003": "09110",  # hartford, capitol
    "09005": "09160",  # litchfield, northwest hills
    "09007": "09130",  # middlesex, lower connecticut river valley
    "09009": "09170",  # new haven, south central connecticut
    "09011": "09180",  # new london, southeastern connecticut
    "09013": "09110",  # tolland, capitol
    "09015": "09150",  # windham, northeastern connecticut
}


# an error block bea sent inside a 200, with its code kept for the year probe
class ApiError(RuntimeError):
    def __init__(self, code, description):
        super().__init__(f"bea api error {code} {description}".strip())
        self.code = code
        self.description = description


# the key must never reach a message, a file or the manifest
def redact(text, key):
    text = str(text)
    if not key:
        return text
    return re.sub(re.escape(key), "REDACTED", text, flags=re.IGNORECASE)


def this_year():
    return datetime.date.today().year


# first_year through last calendar year, asked for in one comma list
def bulk_years(year):
    return list(range(FIRST_YEAR, year))


def year_param(years):
    return ",".join(str(y) for y in years)


# the five digit county fips as bea sends it, none for anything else
def county_fips(geo_fips):
    text = str(geo_fips or "").strip()
    return text if FIPS.fullmatch(text) else None


# a four digit calendar year as an int, none for anything else
def period_year(text):
    text = str(text or "").strip()
    return int(text) if YEAR.fullmatch(text) else None


# "7,116,829" -> 7116829.0. bea flags a missing value in parentheses, (NA) or (D)
def parse_value(text):
    if text is None:
        return None
    cleaned = str(text).replace(",", "").strip()
    if not cleaned or cleaned.startswith("("):
        return None
    try:
        value = float(cleaned)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


# the results block of a response. bea reports failures inside a 200, either
# at the top level or inside results, so both become an api error here
def results(payload):
    api = payload.get("BEAAPI") if isinstance(payload, dict) else None
    if not isinstance(api, dict):
        raise RuntimeError("bea response has no BEAAPI block")
    block = api.get("Results", {})
    if isinstance(block, list):
        block = block[0] if block else {}
    error = api.get("Error") or (block.get("Error") if isinstance(block, dict) else None)
    if isinstance(error, dict):
        raise ApiError(str(error.get("APIErrorCode", "")).strip(), str(error.get("APIErrorDescription", "")).strip())
    if error:
        raise ApiError("", str(error))
    if not isinstance(block, dict):
        raise RuntimeError("bea response has no results block")
    return block


# the data rows of a results block. a single row comes back as a bare object
def data_rows(block):
    rows = block.get("Data", [])
    if isinstance(rows, dict):
        rows = [rows]
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


# one line's rows -> county_fips, period, value. rows without a five digit
# fips, a year from first_year on or a usable value are skipped. bea writes 0
# for a geography it did not estimate that year, connecticut's planning
# regions before 2024 and its counties from 2024 on, so zero is unusable too.
# a repeated county and year keeps its first value
def parse_counties(rows, first_year=FIRST_YEAR):
    records = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        fips = county_fips(row.get("GeoFips"))
        year = period_year(row.get("TimePeriod"))
        value = parse_value(row.get("DataValue"))
        if fips is None or year is None or year < first_year or value is None or value <= 0:
            continue
        records.append({"county_fips": fips, "period": str(year), "value": value})
    df = pd.DataFrame(records, columns=COUNTY_COLUMNS)
    df = df.drop_duplicates(subset=["county_fips", "period"], keep="first")
    return df.sort_values(["county_fips", "period"]).reset_index(drop=True)


# every row of a line must carry the unit and power of ten its metric was
# built for. a changed unit would silently rescale a metric, so the run stops
def check_units(rows, line):
    spec = LINES[line]
    expected = (spec["unit"].lower(), spec["unit_mult"])
    seen = {(str(row.get("CL_UNIT", "")).strip().lower(), str(row.get("UNIT_MULT", "")).strip())
            for row in rows if isinstance(row, dict)}
    if seen and seen != {expected}:
        raise RuntimeError(f"bea line {line} reports CL_UNIT and UNIT_MULT {sorted(seen - {expected})}, "
                           f"expected {spec['unit']} with UNIT_MULT {spec['unit_mult']}")


# one year's counties with both lines side by side. a county counts only
# when its income and its population are both known, so per capita at every
# level is the same income over the same people
def pair_lines(income, population, period):
    both = income[income["period"] == str(period)].merge(
        population[population["period"] == str(period)], on="county_fips",
        suffixes=("_income", "_population"))
    return pd.DataFrame({"county_fips": both["county_fips"],
                         INCOME: both["value_income"], POPULATION: both["value_population"]})


# the crosswalk plus one row per combined code and code its parts share. a
# combined area whose parts sit in different cbsas has no single place to
# go, so the run stops rather than sum it into the wrong one
def extend_crosswalk(crosswalk):
    codes_of = {}
    for fips, code in zip(crosswalk["county_fips"], crosswalk["cbsa_code"]):
        codes_of.setdefault(fips, set()).add(code)
    extra = []
    for combined, parts in COMBINED.items():
        placements = {frozenset(codes_of.get(part, ())) for part in parts}
        if len(placements) > 1:
            raise RuntimeError(f"bea combined area {combined} has parts in different cbsas "
                               f"{sorted(sorted(p) for p in placements)}")
        extra += [{"county_fips": combined, "cbsa_code": code} for code in sorted(placements.pop())]
    frames = [crosswalk] + ([pd.DataFrame(extra)] if extra else [])
    return pd.concat(frames, ignore_index=True)


# irs.aggregate sums the columns irs.METRICS names and returns the long
# shape, so the two bea columns borrow the first two irs names for the call
# and take their own back. the borrowed names never leave this function
def aggregate(counties, crosswalk, period):
    if len(irs.METRICS) < len(SUMMED):
        raise RuntimeError("irs.METRICS names fewer columns than the bea rollup sums")
    borrowed = dict(zip(SUMMED, irs.METRICS))
    frame = counties.rename(columns=borrowed)
    for name in irs.METRICS[len(SUMMED):]:
        frame[name] = 0
    long = irs.aggregate(frame, crosswalk, period)
    own = {irs_name: bea_name for bea_name, irs_name in borrowed.items()}
    long = long[long["metric"].isin(own)].copy()
    long["metric"] = long["metric"].map(own)
    return long.sort_values(["cbsa_code", "metric"]).reset_index(drop=True)


# personal income in thousands of dollars over persons, rounded half up to
# the dollar. none when there are no people to divide by
def per_capita(income, population):
    if income is None or population is None or pd.isna(income) or pd.isna(population) or population <= 0:
        return None
    return int(math.floor(float(income) * 1000 / float(population) + 0.5))


# one year's three metrics for every code with a paired county
def rollup(counties, crosswalk, period):
    long = aggregate(counties, crosswalk, period)
    if long.empty:
        return pd.DataFrame(columns=COLUMNS)
    wide = long.pivot(index="cbsa_code", columns="metric", values="value")
    derived = [
        {"cbsa_code": code, "metric": PER_CAPITA, "period": str(period), "value": value}
        for code, income, population in zip(wide.index, wide[INCOME], wide[POPULATION])
        if (value := per_capita(income, population)) is not None
    ]
    frames = [long] + ([pd.DataFrame(derived, columns=COLUMNS)] if derived else [])
    out = pd.concat(frames, ignore_index=True)
    out["value"] = out["value"].astype(int)
    return out.sort_values(["cbsa_code", "metric"]).reset_index(drop=True)


# the bulk response with the data rows of every accepted probe appended, so
# each line lands in one file
def merge_payloads(payloads):
    merged = copy.deepcopy(payloads[0])
    block = results(merged)
    block["Data"] = [row for payload in payloads for row in data_rows(results(payload))]
    return merged


# a copy of the response holding only the data rows for the years used, so
# the committed raw file matches the rollup. everything else is kept
def trim_payload(payload, years):
    keep = {int(y) for y in years}
    trimmed = copy.deepcopy(payload)
    block = results(trimmed)
    block["Data"] = [row for row in data_rows(block) if period_year(row.get("TimePeriod")) in keep]
    # the production stamp changes on every response and would re-commit the
    # file monthly with no data change
    block.pop("UTCProductionTime", None)
    return trimmed


def write_metrics(df, path):
    out = df[COLUMNS].copy()
    out["value"] = out["value"].astype(int)
    out.to_csv(path, index=False)
    return path


# one api call. the key rides in the query and never in a message
def _get(key, params):
    query = {"UserID": key, "datasetname": DATASET, "ResultFormat": "json", **params}
    try:
        response = fetch(ENDPOINT, params=query)
    except Exception as e:
        raise RuntimeError(f"bea request failed: {redact(e, key)}") from None
    if not response.ok:
        raise RuntimeError(f"bea returned HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError:
        raise RuntimeError(f"bea returned a non json body with HTTP {response.status_code}") from None
    try:
        results(payload)
    except ApiError as e:
        raise ApiError(e.code, redact(e.description, key)) from None
    except RuntimeError as e:
        raise RuntimeError(redact(e, key)) from None
    return payload


# raw responses are committed, so the request echo must not carry the key
def _save(path, payload, key):
    path.write_text(redact(json.dumps(payload, separators=(",", ":")), key) + "\n")
    return path


def _query(**params):
    return ENDPOINT + "?" + "&".join(f"{k}={v}" for k, v in params.items())


def _download(url):
    response = fetch(url)
    if response.status_code != 200:
        raise RuntimeError(f"{url.rsplit('/', 1)[-1]} answered HTTP {response.status_code}")
    return response.content


# the crosswalk plus one row per connecticut county and code the region that
# succeeded it carries. a region the delineation does not name adds nothing,
# and a delineation that names the county itself keeps its own row, since two
# rows for one county would count it twice
def add_connecticut(crosswalk):
    codes_of = {}
    for fips, code in zip(crosswalk["county_fips"], crosswalk["cbsa_code"]):
        codes_of.setdefault(fips, set()).add(code)
    extra = [{"county_fips": county, "cbsa_code": code}
             for county, region in sorted(CONNECTICUT.items()) if county not in codes_of
             for code in sorted(codes_of.get(region, ()))]
    return pd.concat([crosswalk, pd.DataFrame(extra)], ignore_index=True) if extra else crosswalk


# the county to code mapping: the delineation workbook, bea's combined areas
# and connecticut's counties
def load_crosswalk():
    return add_connecticut(extend_crosswalk(irs.parse_crosswalk(_download(irs.DELINEATION_URL))))


def line_params(line, years):
    return {"method": "GetData", "TableName": TABLE, "LineCode": line,
            "GeoFips": "COUNTY", "Year": year_param(years)}


# one line for one later year. none when bea has not published it
def _probe(key, line, year):
    time.sleep(PAUSE_SECONDS)
    try:
        payload = _get(key, line_params(line, [year]))
    except ApiError as e:
        if e.code == NOT_PUBLISHED:
            return None
        raise
    return payload if data_rows(results(payload)) else None


def collect():
    key = env_key("BEA_API_KEY")
    if not key:
        print("[bea] BEA_API_KEY is not set, skipping the bea source")
        return None

    print("[bea] fetching the omb july 2023 delineation file")
    crosswalk = load_crosswalk()

    years = bulk_years(this_year())
    payloads, year_requests = {}, {}
    for line, spec in LINES.items():
        time.sleep(PAUSE_SECONDS)
        print(f"[bea] fetching {TABLE} line {line}, {spec['metric']}, every county, "
              f"{years[0]} through {years[-1]}")
        payloads[line] = [_get(key, line_params(line, years))]
        year_requests[line] = [year_param(years)]

    # a year not in the list yet is tried one at a time, both lines, from the
    # calendar year on until the first one bea does not have
    year = years[-1] + 1
    while True:
        probes = {}
        for line in LINES:
            payload = _probe(key, line, year)
            if payload is None:
                break
            probes[line] = payload
        if len(probes) < len(LINES):
            print(f"[bea] {year} is not published")
            break
        for line, payload in probes.items():
            payloads[line].append(payload)
            year_requests[line].append(str(year))
        years.append(year)
        year += 1

    counties, received = {}, {}
    for line in LINES:
        rows = [row for payload in payloads[line] for row in data_rows(results(payload))]
        check_units(rows, line)
        counties[line] = parse_counties(rows)
        received[line] = len(rows)
    used = sorted(set(counties["1"]["period"]) & set(counties["2"]["period"]) & {str(y) for y in years})
    if not used:
        raise RuntimeError(f"bea returned no {TABLE} county rows from {FIRST_YEAR} onward")

    frames = []
    placed = set(crosswalk["county_fips"])
    for period in used:
        paired = pair_lines(counties["1"], counties["2"], period)
        frames.append(rollup(paired, crosswalk, period))
        inside = len(set(paired["county_fips"]) & placed)
        print(f"[bea] {period}: {len(paired)} counties with both lines, {inside} inside a cbsa")
    df = pd.concat(frames, ignore_index=True)
    df = df.sort_values(["cbsa_code", "metric", "period"]).reset_index(drop=True)
    newest = used[-1]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    metrics_file = write_metrics(df, OUT_DIR / "metrics.csv")
    entries = [manifest_entry(
        metrics_file,
        _query(method="GetData", datasetname=DATASET, TableName=TABLE, GeoFips="COUNTY", Year=year_param(used)),
        PROVIDER,
        "Regional Economic Accounts, CAINC1 personal income summary, county rows summed to cbsa and "
        "metropolitan division codes, annual",
        f"{TABLE} county rollup, {used[0]} through {newest}", len(df),
        {
            "metrics": {
                INCOME: {"line": "1", "unit": LINES["1"]["unit"]},
                POPULATION: {"line": "2", "unit": LINES["2"]["unit"]},
                PER_CAPITA: {"derived": "personal income times 1000 over population, rounded half up to the dollar"},
            },
            "rule": "lines 1 and 2 are pulled per county and summed to every cbsa and, inside a division, to "
                    "that division too. a county counts in a year only when both lines carry a value above "
                    "zero, since bea writes 0 for a geography it did not estimate that year. a combined area "
                    "bea reports under its own code takes the cbsa its parts share",
            "combined_areas": sorted(COMBINED),
            # a connecticut county, which bea publishes through 2023, counts
            # in the cbsa of the planning region that succeeded it
            "connecticut_counties": CONNECTICUT,
            "delineation": irs.DELINEATION_URL,
            "years": f"{used[0]} through {newest}",
            "next_year_probed": f"{year} not published",
            "cbsa_codes": int(df["cbsa_code"].nunique()),
        },
    )]
    for line, spec in LINES.items():
        payload = trim_payload(merge_payloads(payloads[line]), used)
        kept = len(data_rows(results(payload)))
        path = _save(OUT_DIR / f"cainc1_line{line}.json", payload, key)
        entries.append(manifest_entry(
            path, _query(method="GetData", datasetname=DATASET, TableName=TABLE, LineCode=line,
                         GeoFips="COUNTY", Year=year_requests[line][0]),
            PROVIDER, f"{TABLE} line {line}, {spec['metric']}, every county",
            f"{TABLE} line {line} through {newest}", kept,
            {"metric": spec["metric"], "unit": spec["unit"], "unit_mult": spec["unit_mult"],
             "year_requests": year_requests[line], "rows_received": received[line], "rows_kept": kept},
        ))
        print(f"[bea] line {line}: {kept} rows for {used[0]} through {newest} of {received[line]} received "
              f"-> {path.name}")

    write_manifest(OUT_DIR, entries)
    print(f"[bea] {len(df)} rows, {df['cbsa_code'].nunique()} codes, {used[0]} through {newest} "
          f"-> {metrics_file.name}")
    return metrics_file

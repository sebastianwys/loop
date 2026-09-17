# hud user api: fair market rents and income limits by metro area. every
# metro entity and year is one call, so the run covers the study years plus
# the newest year each dataset offers rather than every year since 2014
#
# hud publishes for its own fmr areas, not for every cbsa. 66 of the 410 study
# codes have no whole metro entity: hud splits the metro into smaller fmr
# areas, or still keys it by the pre 2023 cbsa code, or carries it as ordinary
# counties. those codes are rebuilt from the counties the omb delineation gives
# them, each county carrying the value of the fmr area it sits in, weighted by
# population
import json
import math
import re
import time
from pathlib import Path

import pandas as pd
import requests

from bot.common import (
    INTEGRATED, RAW_DIR, STUDY_YEARS, USER_AGENT, env_key, fetch, manifest_entry, write_manifest,
)

OUT_DIR = RAW_DIR / "hud"
OUT_FILE = OUT_DIR / "metrics.csv"
API = "https://www.huduser.gov/hudapi/public"
LIST_URL = f"{API}/fmr/listMetroAreas"
STATE_LIST_URL = f"{API}/fmr/listStates"
STATE_URL = f"{API}/fmr/statedata/"
FMR_URL = f"{API}/fmr/data/"
IL_URL = f"{API}/il/data/"
PROVIDER = "U.S. Department of Housing and Urban Development, HUD User"
COLUMNS = ["cbsa_code", "metric", "period", "value"]
TWO_BEDROOM = "Two-Bedroom"

# the counties of every cbsa and division, written by the gazetteer collector
# from the omb delineation. without it no rollup can be built
MEMBERSHIP = RAW_DIR / "gazetteer" / "cbsa_counties.csv"

# acs population, the weight a county or town carries in a rollup. the vintage
# is the newest study year, the same one the rest of the pipeline reads
CENSUS_URL = "https://api.census.gov/data/{year}/acs/acs5"
CENSUS_VINTAGE = STUDY_YEARS[-1]
POPULATION = "B01003_001E"

# hud keys these six states town by town and everywhere else county by county.
# connecticut is the one state where hud's town rows still carry the pre 2022
# counties while the delineation carries planning regions, so its towns are
# matched and weighted by the town code alone
NEW_ENGLAND = {"09", "23", "25", "33", "44", "50"}

# the census county subdivision row that stands for the part of a county with
# no town, never a place hud publishes for
NO_SUBDIVISION = "00000"

# same timeout as bot.common.fetch. hud allows 60 requests a minute
# (X-RateLimit-Limit), so a little over one second between calls
TIMEOUT = 120
MIN_INTERVAL = 1.05

# a metro entity id carries the cbsa code twice, METRO10180M10180. a hud metro
# fmr subarea carries MM plus an old pmsa code or N plus a county fips instead,
# as in METRO29180N22001, and covers only part of the metro
ENTITY = re.compile(r"^METRO(\d{5})M(\d{5})$")


# the list endpoints wrap their rows in "data". a bare list is accepted too
def list_entries(payload):
    if isinstance(payload, dict):
        payload = payload.get("data")
    return payload if isinstance(payload, list) else []


# cbsa code -> whole metro entity id. subareas, malformed rows and repeats
# are dropped, and the first entity seen for a code wins
def parse_metro_list(payload):
    ids = {}
    for entry in list_entries(payload):
        if not isinstance(entry, dict):
            continue
        match = ENTITY.match(str(entry.get("cbsa_code", "")).strip())
        if match and match.group(1) == match.group(2):
            ids.setdefault(match.group(1), match.group(0))
    return ids


# hud flags the metro's own row inside a zip breakdown as "MSA level"
def _is_metro_level(entry):
    return isinstance(entry, dict) and any(
        re.sub(r"[^a-z]", "", value.lower()) == "msalevel"
        for value in entry.values() if isinstance(value, str)
    )


# a plain area answers with one object, a small area fmr metro with a list of
# zip rows where the metro's own row is flagged. none when no metro row exists
def metro_record(block):
    if isinstance(block, dict):
        return block
    if isinstance(block, list):
        return next((entry for entry in block if _is_metro_level(entry)), None)
    return None


# hud sends "948.0" in some years and 948 in others. a rent or an income is
# positive, so zero and below count as missing
def to_number(value):
    try:
        number = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def _data(payload):
    return metro_record(payload.get("data")) if isinstance(payload, dict) else None


# two bedroom fair market rent of the metro, dollars a month
def parse_fmr(payload):
    data = _data(payload)
    basic = metro_record(data.get("basicdata")) if data else None
    return to_number(basic.get(TWO_BEDROOM)) if basic else None


# median family income behind the income limits, dollars a year
def parse_income_limits(payload):
    data = _data(payload)
    return to_number(data.get("median_income")) if data else None


# the year a payload describes. fmr keeps it inside basicdata in some years
def payload_year(payload):
    data = _data(payload)
    if not data:
        return None
    year = data.get("year")
    if year is None and isinstance(data.get("basicdata"), dict):
        year = data["basicdata"].get("year")
    text = str(year).strip() if year is not None else ""
    return int(text) if text.isdigit() else None


# one row per code, metric and year in the map's four columns. missing values
# are dropped and a repeat of the same key keeps the last value seen
def build_rows(records):
    rows = [(code, metric, str(year), value) for code, metric, year, value in records if value is not None]
    df = pd.DataFrame(rows, columns=COLUMNS)
    df = df.drop_duplicates(["cbsa_code", "metric", "period"], keep="last")
    return df.sort_values(["metric", "cbsa_code", "period"]).reset_index(drop=True)


# study code -> geo level, sorted by code
def study_codes(path):
    df = pd.read_csv(path, dtype=str, usecols=["cbsa_code", "geo_level"]).drop_duplicates("cbsa_code")
    return dict(sorted(zip(df["cbsa_code"].str.strip(), df["geo_level"].fillna("msa"))))


# --- rollups: a cbsa hud has no entity for, rebuilt from its counties ---


# cbsa code -> county fips, from the gazetteer collector. an absent file means
# no rollup is possible, which the caller reports rather than fails on
def load_membership(path):
    path = Path(path)
    if not path.exists():
        return {}
    df = pd.read_csv(path, dtype=str).dropna(subset=["cbsa_code", "county_fips"])
    groups = {}
    for code, fips in zip(df["cbsa_code"].str.strip(), df["county_fips"].str.strip()):
        groups.setdefault(code, []).append(fips)
    return {code: sorted(set(fips)) for code, fips in groups.items()}


# two digit state fips -> postal code, for the statedata endpoint. hud sends
# the number as a float in some rows, "9.0" for connecticut
def parse_state_list(payload):
    codes = {}
    for entry in list_entries(payload):
        if not isinstance(entry, dict):
            continue
        code = str(entry.get("state_code", "")).strip().upper()
        try:
            fips = f"{int(float(str(entry.get('state_num', '')).strip())):02d}"
        except ValueError:
            continue
        if len(code) == 2:
            codes.setdefault(fips, code)
    return codes


# every county or town row one state publishes for a year, keyed by the fips
# hud takes as an entity id: a county is its five digit fips then 99999, a new
# england town is state, county and town code. the value is the area the row
# belongs to and its two bedroom rent
def parse_state_rows(payload):
    data = payload.get("data") if isinstance(payload, dict) else None
    rows = data.get("counties") if isinstance(data, dict) else None
    out = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        fips = str(row.get("fips_code", "")).strip()
        area = str(row.get("metro_name", "")).strip()
        if len(fips) == 10 and area:
            out[fips] = (area, to_number(row.get(TWO_BEDROOM)))
    return out


# the county a hud row sits in, as the delineation names it. a county row says
# so in its own fips; a town row is placed by the census, which is the only way
# a connecticut town reaches its planning region
def home_county(fips, regions):
    if fips.endswith("99999"):
        return fips[:5]
    return regions.get(fips[:2] + fips[5:], fips[:5])


# the hud rows that make up one cbsa, in a stable order
def rows_for(counties, rows, regions):
    wanted = set(counties)
    return [(fips, rows[fips]) for fips in sorted(rows) if home_county(fips, regions) in wanted]


# the population behind one hud row. towns are keyed by state and town code so
# that connecticut, where hud and the census disagree about the county, still
# finds its weight
def weight_of(fips, county_pop, town_pop):
    if fips.endswith("99999"):
        return county_pop.get(fips[:5])
    return town_pop.get(fips[:2] + fips[5:])


# one value for a cbsa from the rows inside it, weighted by population. a row
# with no value is left out of both sums. a cbsa whose counties all sit in one
# fmr area reads the same value from every row, and the mean of one value is
# that value whatever the weights are, so it resolves even with no weights
def weighted(parts):
    usable = [(value, weight) for value, weight in parts if value is not None]
    if not usable:
        return None
    if len({value for value, _ in usable}) == 1:
        return usable[0][0]
    weighed = [(value, weight) for value, weight in usable if weight]
    total = sum(weight for _, weight in weighed)
    if not total:
        return None
    return sum(value * weight for value, weight in weighed) / total


# the census answers with a header row then one row per place. anything that is
# not a 200 carrying json comes back empty, so a rollup falls back to the rows
# it can still weigh
def census_rows(params, key):
    response = fetch(CENSUS_URL.format(year=CENSUS_VINTAGE), params=dict(params, key=key) if key else params)
    if response.status_code != 200:
        return []
    try:
        rows = response.json()
    except ValueError:
        return []
    return rows[1:] if isinstance(rows, list) and len(rows) > 1 else []


# county populations for the whole country and town populations for the new
# england states in play, plus the county the census puts each town in. a town
# code repeated across two counties, which happens once in maine, is summed
def census_population(states, key):
    county_pop, town_pop, regions = {}, {}, {}
    for row in census_rows({"get": POPULATION, "for": "county:*"}, key):
        value, state, county = row[0], row[-2], row[-1]
        population = to_number(value)
        if population:
            county_pop[state + county] = population
    for state in sorted(state for state in states if state in NEW_ENGLAND):
        for row in census_rows({"get": POPULATION, "for": "county subdivision:*", "in": f"state:{state}"}, key):
            value, town = row[0], row[-1]
            if town == NO_SUBDIVISION:
                continue
            town_key = row[-3] + town
            regions[town_key] = row[-3] + row[-2]
            population = to_number(value)
            if population:
                town_pop[town_key] = town_pop.get(town_key, 0.0) + population
    return county_pop, town_pop, regions


DATASETS = {
    "fmr": (FMR_URL, "fmr_2br", parse_fmr),
    "il": (IL_URL, "median_family_income", parse_income_limits),
}


# bot.common.fetch cannot send a header, so this repeats its policy for the
# bearer token: same user agent and timeout, retries on connection errors and
# 5xx, and waits out the minute on 429, with a pause that keeps requests under
# the limit. the token lives only in the header and is stripped from any error text
# seconds to wait on a 429: the Retry-After header when it is a number, else a minute
def retry_after(response):
    value = getattr(response, "headers", {}).get("Retry-After", "")
    text = str(value)
    return float(text) if text.replace(".", "", 1).isdigit() else 61.0


class Client:
    def __init__(self, token):
        self.token = token
        self.headers = {"User-Agent": USER_AGENT, "Authorization": f"Bearer {token}"}
        self.last = 0.0

    def pace(self):
        wait = MIN_INTERVAL - (time.monotonic() - self.last)
        if wait > 0:
            time.sleep(wait)
        self.last = time.monotonic()

    def get(self, url, params=None, retries=5):
        last_error = None
        for attempt in range(retries):
            self.pace()
            try:
                response = requests.get(url, params=params, timeout=TIMEOUT, headers=self.headers)
                if response.status_code == 429:
                    # the per minute window has to roll over before anything succeeds
                    time.sleep(retry_after(response))
                    last_error = RuntimeError("HTTP 429")
                    continue
                if response.status_code < 500:
                    return response
                last_error = RuntimeError(f"HTTP {response.status_code}")
            except requests.RequestException as e:
                last_error = RuntimeError(str(e).replace(self.token, "<token>"))
            time.sleep(2 ** attempt)
        raise last_error

    # (status, body). 401 and 403 stop the run. anything else that is not a
    # 200 with valid json comes back with no body for the caller to count
    def get_json(self, url, params=None):
        response = self.get(url, params=params)
        status = response.status_code
        if status in (401, 403):
            raise RuntimeError(f"hud returned HTTP {status}, check HUD_API_TOKEN and its dataset registration")
        if status != 200:
            return status, None
        try:
            return status, response.json()
        except ValueError:
            return "malformed", None


# the year hud answers with when none is asked for. tries a few entities in
# case the first has no current row
def newest_year(client, base, entities):
    for entity in list(entities)[:3]:
        _, payload = client.get_json(base + entity)
        year = payload_year(payload)
        if year:
            return year
    return None


# the years worth asking every metro about. the api has no fair market rents
# or income limits before fiscal 2017, and one call per metro for a year that
# holds nothing is a thousand refusals, so a year a few entities all refuse is
# dropped here and recorded as missing
def usable_years(client, base, entities, years):
    keep = []
    for year in years:
        for entity in list(entities)[:3]:
            _, payload = client.get_json(base + entity, {"year": year})
            if payload_year(payload):
                keep.append(year)
                break
    return keep


# the rollup values for one year. fresh holds the rows hud published for this
# year, so a rent comes from the year asked for; layout holds the newest county
# to fmr area map known, which is all income limits need, since they are asked
# one fmr area at a time rather than one county at a time
def rollup_records(client, year, years_for, rollups, rows, geo, captured, skipped, areas):
    fresh, layout = rows
    regions, county_pop, town_pop = geo
    records, income, found = [], {}, {"fmr": 0, "il": 0}
    for code, counties in rollups.items():
        placed = rows_for(counties, layout, regions)
        if placed:
            areas[code] = sorted({area for _, (area, _) in placed})
        if year in years_for["fmr"]:
            parts = [(rent, weight_of(fips, county_pop, town_pop))
                     for fips, (_, rent) in rows_for(counties, fresh, regions)]
            value = weighted(parts)
            if value is not None:
                records.append((code, DATASETS["fmr"][1], year, float(round(value))))
                found["fmr"] += 1
        if year in years_for["il"]:
            parts = []
            for fips, (area, _) in placed:
                if area not in income:
                    status, payload = client.get_json(IL_URL + fips, {"year": year})
                    if isinstance(payload, dict) and "data" in payload:
                        captured["il"][fips] = payload
                        income[area] = parse_income_limits(payload)
                    else:
                        key = str(status) if payload is None else "nodata"
                        skipped[key] = skipped.get(key, 0) + 1
                        income[area] = None
                parts.append((income[area], weight_of(fips, county_pop, town_pop)))
            value = weighted(parts)
            if value is not None:
                records.append((code, DATASETS["il"][1], year, float(round(value))))
                found["il"] += 1
    print(f"[hud] rollups {year}: {found['fmr']} fmr and {found['il']} income limit values "
          f"from {len(rollups)} codes, {len(income)} fmr areas asked")
    return records


def collect():
    token = env_key("HUD_API_TOKEN")
    if not token:
        print("[hud] HUD_API_TOKEN is not set, source skipped")
        return None
    client = Client(token)

    print("[hud] fetching the metro area list")
    status, listing = client.get_json(LIST_URL)
    ids = parse_metro_list(listing)
    if not ids:
        raise RuntimeError(f"hud metro list came back empty (HTTP {status})")

    # a division has its own cbsa code and hud keys on the metro's, so no
    # division matches an entity. neither do the metros hud splits into smaller
    # fmr areas, still calls by a pre 2023 code, or carries as plain counties.
    # every one of them is rebuilt from the counties the delineation gives it
    levels = study_codes(INTEGRATED)
    entities = {code: ids[code] for code in levels if code in ids}
    absent = [code for code in levels if code not in ids]
    membership = load_membership(MEMBERSHIP)
    rollups = {code: membership[code] for code in absent if code in membership}
    unresolved = [code for code in absent if code not in rollups]
    divisions = sum(levels[code] == "division" for code in absent)
    print(f"[hud] {len(entities)} of {len(levels)} study codes have a metro entity, "
          f"{len(absent) - divisions} metros and {divisions} divisions without one, "
          f"{len(list_entries(listing)) - len(ids)} subarea or repeated entries skipped")
    if not entities:
        raise RuntimeError("no study code matches a hud metro entity")
    if unresolved:
        print(f"[hud] {len(unresolved)} codes have neither an entity nor counties in "
              f"{MEMBERSHIP.name}, their values stay missing: {', '.join(unresolved)}")

    newest, years_for, requested = {}, {}, {}
    for dataset, (base, _, _) in DATASETS.items():
        newest[dataset] = newest_year(client, base, entities.values())
        requested[dataset] = sorted(set(STUDY_YEARS) | ({newest[dataset]} if newest[dataset] else set()))
        years_for[dataset] = usable_years(client, base, entities.values(), requested[dataset])
    print(f"[hud] newest years: fmr {newest['fmr']}, il {newest['il']}")
    for dataset, years in requested.items():
        empty = [year for year in years if year not in years_for[dataset]]
        if empty:
            print(f"[hud] {dataset} has nothing for {empty}, those years are not asked for again")

    states, needed, county_pop, town_pop, regions = {}, [], {}, {}, {}
    if rollups:
        states = parse_state_list(client.get_json(STATE_LIST_URL)[1])
        needed = sorted({fips[:2] for counties in rollups.values() for fips in counties})
        county_pop, town_pop, regions = census_population(needed, env_key("CENSUS_API_KEY"))
        print(f"[hud] {len(rollups)} codes rebuilt from {sum(len(c) for c in rollups.values())} "
              f"counties across {len(needed)} states, weights: {len(county_pop)} counties "
              f"and {len(town_pop)} towns")
        if not county_pop:
            print("[hud] no census population came back, only codes that sit in one fmr area resolve")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    records, skipped, raw_files, rolled = [], {}, [], {}
    rows_by_state = {}
    for year in sorted(set(years_for["fmr"]) | set(years_for["il"])):
        captured = {"year": year, "fmr": {}, "il": {}, "states": {}}
        for dataset, (base, metric, parse) in DATASETS.items():
            if year not in years_for[dataset]:
                continue
            found = 0
            for code, entity in entities.items():
                status, payload = client.get_json(base + entity, {"year": year})
                if not isinstance(payload, dict) or "data" not in payload:
                    key = str(status) if payload is None else "nodata"
                    skipped[key] = skipped.get(key, 0) + 1
                    continue
                captured[dataset][entity] = payload
                value = parse(payload)
                if value is not None:
                    records.append((code, metric, year, value))
                    found += 1
            print(f"[hud] {dataset} {year}: {found} of {len(entities)} metros with a value")

        if rollups:
            # this year's county and town rows carry this year's rents. an
            # older year stands in for the layout alone, so that a year one
            # dataset publishes and the other does not still knows which fmr
            # area a county sits in
            fresh, layout = {}, {}
            for fips in needed:
                postal = states.get(fips)
                if not postal:
                    skipped["no state code"] = skipped.get("no state code", 0) + 1
                    continue
                status, payload = client.get_json(STATE_URL + postal, {"year": year})
                rows = parse_state_rows(payload) if isinstance(payload, dict) else {}
                if rows:
                    captured["states"][postal] = payload
                    rows_by_state[postal] = rows
                    fresh.update(rows)
                else:
                    skipped[f"statedata {status}"] = skipped.get(f"statedata {status}", 0) + 1
                layout.update(rows or rows_by_state.get(postal, {}))
            records.extend(rollup_records(client, year, years_for, rollups, (fresh, layout),
                                          (regions, county_pop, town_pop), captured, skipped, rolled))

        count = len(captured["fmr"]) + len(captured["il"]) + len(captured["states"])
        if count:
            path = OUT_DIR / f"hud_{year}.json"
            path.write_text(json.dumps(captured) + "\n")
            raw_files.append((path, year, count))

    df = build_rows(records)
    df.to_csv(OUT_FILE, index=False)

    all_years = sorted(set(requested["fmr"]) | set(requested["il"]))
    have = set(df["period"])
    through = {}
    for dataset, (_, metric, _) in DATASETS.items():
        periods = df.loc[df["metric"] == metric, "period"]
        through[dataset] = periods.max() if len(periods) else "none"
    built = sorted(set(df["cbsa_code"]) & set(rolled))
    weighted_codes = [code for code in built if len(rolled[code]) > 1]
    version = f"fmr through {through['fmr']}, income limits through {through['il']}"
    if built:
        version += f", {len(built)} metros built from hud fmr areas"
    entries = [manifest_entry(
        OUT_FILE, FMR_URL + "{entityid}?year={year}", PROVIDER,
        "Fair market rents, two bedroom, and income limits, median family income, by metro area and fiscal year",
        version, len(df),
        {
            "income_limits_endpoint": IL_URL + "{entityid}?year={year}",
            "metro_list": LIST_URL,
            "state_data_endpoint": STATE_URL + "{state}?year={year}",
            "entities": len(entities),
            "study_codes": len(levels),
            "years": years_for,
            "years_without_data": [y for y in all_years if str(y) not in have],
            "responses_skipped": skipped,
            # a code hud has no entity for is rebuilt from its counties. one
            # fmr area means the value is that area's as hud published it, more
            # than one means an acs population weighted mean of them
            "rollup_method": "acs population weighted mean over the hud fmr areas the cbsa's counties sit in",
            "rollup_weights": f"acs 5 year {CENSUS_VINTAGE} {POPULATION}, counties and new england towns",
            "rollup_codes": len(built),
            "rollup_codes_weighted": len(weighted_codes),
            "rollup_areas": {code: rolled[code] for code in built},
            "codes_without_a_value": sorted(set(levels) - set(df["cbsa_code"])),
        },
    )]
    for path, year, count in raw_files:
        entries.append(manifest_entry(
            path, API, PROVIDER,
            f"raw fmr, il and state responses per entity for fiscal year {year}",
            str(year), count,
        ))
    write_manifest(OUT_DIR, entries)
    print(f"[hud] {len(df)} rows, {df['metric'].nunique()} metrics -> {OUT_FILE.name}")
    return OUT_FILE

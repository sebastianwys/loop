import re
from pathlib import Path

import pandas as pd

from bot.common import RAW_DIR, STUDY_YEARS, fetch, manifest_entry, staged_folder

OUT_DIR = RAW_DIR / "bps"
OUT_FILE = OUT_DIR / "metrics.csv"
BASE = "https://www2.census.gov/econ/bps/"
# the survey filed metro annuals under Metro through 2023, then moved to a
# cbsa folder that also carries the micropolitan areas
METRO_DIR = BASE + "Metro%20(ending%202023)/"
CBSA_DIR = BASE + "CBSA%20(beginning%20Jan%202024)/"
SPLIT_YEAR = 2024
FIRST_YEAR = 2014
# every annual through the last study year must exist. later years are
# probed one at a time and the first 404 ends the series
REQUIRED_THROUGH = max(STUDY_YEARS)

PROVIDER = "U.S. Census Bureau"
DATASET = ("Building Permits Survey, new privately owned housing units authorized "
           "by building permits, annual, by core based statistical area")

COLUMNS = ["cbsa_code", "metric", "period", "value"]
PARSED = ["year", "cbsa_code", "name", "units_1", "units_2", "units_3_4", "units_5plus"]

# a data row is a survey date of yyyy or yyyymm, then a five digit cbsa code
DATE = re.compile(r"^\d{4}(\d{2})?$")
CODE = re.compile(r"^\d{5}$")
NO_CBSA = "99999"

# zero based field positions of the units count in the estimates with
# imputation block. each class carries buildings, units and value, in that
# order, for 1 unit, 2 units, 3 to 4 units and 5 or more units
UNIT_FIELDS = {"units_1": 6, "units_2": 9, "units_3_4": 12, "units_5plus": 15}
LAST_FIELD = 16

# the file has no total column, so total units is the sum of the four classes
METRICS = {
    "permits_units": ["units_1", "units_2", "units_3_4", "units_5plus"],
    "permits_single_family": ["units_1"],
    "permits_multifamily": ["units_5plus"],
}


# ma<yyyy>a.txt in the metro folder through 2023, cbsa<yyyy>a.txt after
def file_url(year):
    if year >= SPLIT_YEAR:
        return f"{CBSA_DIR}cbsa{year}a.txt"
    return f"{METRO_DIR}ma{year}a.txt"


# "Abilene  TX " -> "Abilene, TX". two spaces separate the cities from the states
def clean_name(raw):
    return re.sub(r"\s{2,}", ", ", raw.strip())


# the rows of one annual file. the two header lines, the blank third line,
# trailing commas and crlf endings are skipped by shape rather than position:
# a data row has a survey date, a five digit cbsa code and at least the
# seventeen fields through the 5+ unit valuation. a unit count that is not a
# number lands as missing
def parse_annual(text):
    rows = []
    for line in text.splitlines():
        fields = [f.strip() for f in line.split(",")]
        if len(fields) <= LAST_FIELD:
            continue
        date, code = fields[0], fields[2]
        if not DATE.match(date) or not CODE.match(code) or code == NO_CBSA:
            continue
        row = {"year": int(date[:4]), "cbsa_code": code, "name": clean_name(fields[4])}
        for col, i in UNIT_FIELDS.items():
            row[col] = fields[i]
        rows.append(row)
    df = pd.DataFrame(rows, columns=PARSED)
    for col in UNIT_FIELDS:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


# the three map metrics per area and year in the builder's column contract. a
# metric with a missing input is left out rather than written as zero, and an
# area repeated within a year keeps its first row
def annual_metrics(frame):
    parts = []
    for metric, cols in METRICS.items():
        sub = frame.dropna(subset=cols)
        parts.append(pd.DataFrame({
            "cbsa_code": sub["cbsa_code"],
            "metric": metric,
            "period": sub["year"].astype(int).astype(str),
            "value": sub[cols].sum(axis=1).astype(int),
        }))
    out = pd.concat(parts, ignore_index=True)[COLUMNS]
    out = out.drop_duplicates(["cbsa_code", "metric", "period"])
    return out.sort_values(["cbsa_code", "metric", "period"], kind="stable").reset_index(drop=True)


# survey years in a file other than the one its name promises
def stray_years(frame, year):
    return sorted(set(frame["year"].dropna().astype(int)) - {year})


def collect(out_dir=OUT_DIR):
    out_dir = Path(out_dir)
    out_file = out_dir / OUT_FILE.name

    # every annual file, the metrics table and the manifest land together
    with staged_folder(out_dir) as landing:
        frames, entries, year = [], [], FIRST_YEAR
        while True:
            url = file_url(year)
            name = url.rsplit("/", 1)[-1]
            response = fetch(url)
            # the annual file appears some months after the year ends, so a 404
            # past the last study year is the end of the series, not an error
            if response.status_code == 404 and year > REQUIRED_THROUGH:
                print(f"[bps] {name} not published yet, series ends at {year - 1}")
                break
            response.raise_for_status()

            path = landing.bytes(name, response.content)
            frame = parse_annual(response.content.decode("latin-1"))
            stray = stray_years(frame, year)
            if stray:
                raise RuntimeError(f"bps: {name} carries survey years {stray}, expected {year}")
            frames.append(frame)
            entries.append(manifest_entry(path, url, PROVIDER, DATASET, f"{year} annual", len(frame)))
            print(f"[bps] {name}: {len(frame)} areas")
            year += 1

        parsed = pd.concat(frames, ignore_index=True)
        metrics = annual_metrics(parsed)
        staged_metrics = landing.csv(metrics, out_file.name)

        last_year = year - 1
        version = f"{FIRST_YEAR} to {last_year} annual"
        areas = int(parsed["cbsa_code"].nunique())
        landing.manifest([manifest_entry(
            staged_metrics, CBSA_DIR, PROVIDER, DATASET, version, len(metrics),
            {
                "years": [FIRST_YEAR, last_year],
                "files": [entry["filename"] for entry in entries],
                "areas": areas,
                "metrics": list(METRICS),
                "basis": "estimates with imputation. permits_units sums the 1, 2, 3-4 and 5+ unit classes",
            },
        )] + entries)
    print(f"[bps] {len(metrics)} metric rows for {areas} areas, {version} -> {out_file.name}")
    return out_file

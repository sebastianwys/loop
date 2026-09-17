import io
import zipfile

import pandas as pd

from bot.common import RAW_DIR, fetch, manifest_entry, write_manifest

YEAR = 2024
GAZ = f"https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{YEAR}_Gazetteer/{YEAR}_Gaz_"
URL = GAZ + "cbsa_national.zip"
COUNTY_URL = GAZ + "counties_national.zip"
# omb's july 2023 delineation: the county makeup of every cbsa and division
DELINEATION_URL = ("https://www2.census.gov/programs-surveys/metro-micro/geographies/"
                   "reference-files/2023/delineation-files/list1_2023.xlsx")
REFERENCE = "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files"

# the delineation each acs vintage was published on, which is what decides
# whether two vintages of a cbsa code are the same place. omb redraws county
# lines between them and the code does not change, so a growth rate across a
# redraw compares two different places wearing one code. these two files are
# frozen history and will not be republished
VINTAGE_DELINEATIONS = {
    "2014": f"{REFERENCE}/2013/delineation-files/list1.xls",
    "2019": f"{REFERENCE}/2018/delineation-files/list1_Sep_2018.xls",
    "2024": DELINEATION_URL,
}

OUT_DIR = RAW_DIR / "gazetteer"
OUT_FILE = OUT_DIR / "cbsa_centroids.csv"
MEMBERSHIP_FILE = OUT_DIR / "cbsa_counties.csv"
VINTAGE_MEMBERSHIP_FILE = OUT_DIR / "cbsa_counties_by_vintage.csv"

# cbsa_type 1 = metro, 2 = micro from the gazetteer, 3 = division, derived here
DIVISION = 3
COLUMNS = ["cbsa_code", "name", "cbsa_type", "land_sqmi", "lat", "lon", "parent_cbsa"]

KEEP = {
    "GEOID": "cbsa_code",
    "NAME": "name",
    "CBSA_TYPE": "cbsa_type",  # 1 = metro, 2 = micro
    "ALAND_SQMI": "land_sqmi",
    "INTPTLAT": "lat",
    "INTPTLONG": "lon",
}


# the txt inside the zip is tab separated and every line has trailing spaces
def parse_gazetteer(text):
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    header = lines[0].split("\t")
    rows = [dict(zip(header, line.split("\t"))) for line in lines[1:]]
    df = pd.DataFrame(rows)[list(KEEP)].rename(columns=KEEP)
    for col in ("lat", "lon", "land_sqmi"):
        df[col] = df[col].astype(float)
    df["cbsa_type"] = df["cbsa_type"].astype(int)
    return df


# the county file has the same layout, with GEOID as the five digit fips
def parse_counties(text):
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    header = lines[0].split("\t")
    rows = [dict(zip(header, line.split("\t"))) for line in lines[1:]]
    df = pd.DataFrame(rows)[["GEOID", "ALAND_SQMI", "INTPTLAT", "INTPTLONG"]]
    df.columns = ["county_fips", "land_sqmi", "lat", "lon"]
    for col in ("lat", "lon", "land_sqmi"):
        df[col] = df[col].astype(float)
    return df


# the rows of the delineation workbook that belong to a division, one per county.
# the sheet has two title rows above the header
# the 2013 workbook heads the column "Metro Division Code" and the two later
# ones "Metropolitan Division Code". same column, same codes
DIVISION_COLUMNS = ("Metropolitan Division Code", "Metro Division Code")


def read_workbook(content):
    df = pd.read_excel(io.BytesIO(content), header=2, dtype=str)
    division = next((c for c in DIVISION_COLUMNS if c in df.columns), None)
    if division is None:
        raise ValueError(f"delineation workbook has no division column, found {list(df.columns)[:6]}")
    return df, division


def parse_delineation(content):
    df, division = read_workbook(content)
    df = df[df[division].notna()]
    return pd.DataFrame({
        "cbsa_code": df[division].str.strip(),
        "name": df["Metropolitan Division Title"].str.strip() + " Metro Division",
        "parent_cbsa": df["CBSA Code"].str.strip(),
        "county_fips": df["FIPS State Code"].str.strip().str.zfill(2)
        + df["FIPS County Code"].str.strip().str.zfill(3),
    })


# the county makeup of every cbsa and every division, one row per pair. hud
# publishes for its own fmr areas, which are built from counties rather than
# from cbsas, so the hud collector rebuilds a metro out of these counties when
# hud has no entity for the code. a division county is listed twice, once under
# the division and once under its parent metro
def parse_membership(content):
    df, division_col = read_workbook(content)
    fips = (df["FIPS State Code"].str.strip().str.zfill(2)
            + df["FIPS County Code"].str.strip().str.zfill(3))
    division = df[division_col].notna()
    pairs = pd.concat([
        pd.DataFrame({"cbsa_code": df["CBSA Code"].str.strip(), "county_fips": fips}),
        pd.DataFrame({"cbsa_code": df.loc[division, division_col].str.strip(),
                      "county_fips": fips[division]}),
    ], ignore_index=True).dropna()
    pairs = pairs[(pairs["cbsa_code"].str.len() == 5) & (pairs["county_fips"].str.len() == 5)]
    return pairs.drop_duplicates().sort_values(["cbsa_code", "county_fips"]).reset_index(drop=True)


# one membership table per acs vintage, so the map can ask whether a cbsa code
# meant the same counties in two vintages before it reports a growth rate
def vintage_membership(books):
    frames = []
    for vintage, content in sorted(books.items()):
        pairs = parse_membership(content)
        pairs.insert(0, "vintage", vintage)
        frames.append(pairs)
    return pd.concat(frames, ignore_index=True)


# no gazetteer exists for divisions, so each one gets the land weighted mean of
# its counties' internal points
def division_centroids(delineation, counties):
    joined = delineation.merge(counties, on="county_fips", how="left")
    skipped = int(joined["lat"].isna().sum())
    if skipped:
        print(f"[gazetteer] {skipped} division counties without a gazetteer row, skipped")
    joined = joined.dropna(subset=["lat", "lon"])

    rows = []
    for code, group in joined.groupby("cbsa_code", sort=True):
        weights = group["land_sqmi"].clip(lower=0.001)
        rows.append({
            "cbsa_code": code,
            "name": group["name"].iloc[0],
            "cbsa_type": DIVISION,
            "land_sqmi": round(float(group["land_sqmi"].sum()), 3),
            "lat": round(float((group["lat"] * weights).sum() / weights.sum()), 6),
            "lon": round(float((group["lon"] * weights).sum() / weights.sum()), 6),
            "parent_cbsa": group["parent_cbsa"].iloc[0],
        })
    return pd.DataFrame(rows, columns=COLUMNS)


def _download(url):
    response = fetch(url)
    response.raise_for_status()
    return response.content


# the gazetteer files are utf-8, a few names carry accents
def _unzip_text(content):
    archive = zipfile.ZipFile(io.BytesIO(content))
    return archive.read(archive.namelist()[0]).decode("utf-8", errors="replace")


def collect():
    print(f"[gazetteer] fetching {YEAR} cbsa centroids")
    cbsa = parse_gazetteer(_unzip_text(_download(URL)))
    cbsa["parent_cbsa"] = ""

    print("[gazetteer] fetching county centroids and three delineation files")
    counties = parse_counties(_unzip_text(_download(COUNTY_URL)))
    books = {vintage: _download(url) for vintage, url in VINTAGE_DELINEATIONS.items()}
    workbook = books["2024"]
    delineation = parse_delineation(workbook)
    membership = parse_membership(workbook)
    by_vintage = vintage_membership(books)
    divisions = division_centroids(delineation, counties)

    df = pd.concat([cbsa[COLUMNS], divisions], ignore_index=True)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT_FILE, index=False)
    membership.to_csv(MEMBERSHIP_FILE, index=False)
    by_vintage.to_csv(VINTAGE_MEMBERSHIP_FILE, index=False)
    write_manifest(OUT_DIR, [
        manifest_entry(
            OUT_FILE, URL, "U.S. Census Bureau",
            f"{YEAR} Gazetteer cbsa and county internal points, divisions derived from the omb july 2023 delineation",
            f"{YEAR} Gazetteer", len(df),
            {"county_gazetteer": COUNTY_URL, "delineation": DELINEATION_URL, "divisions": int(len(divisions))},
        ),
        manifest_entry(
            MEMBERSHIP_FILE, DELINEATION_URL, "U.S. Office of Management and Budget, via the U.S. Census Bureau",
            "the counties of every cbsa and metropolitan division",
            "omb july 2023 delineation", len(membership),
            {"cbsas": int(membership["cbsa_code"].nunique())},
        ),
        manifest_entry(
            VINTAGE_MEMBERSHIP_FILE, DELINEATION_URL,
            "U.S. Office of Management and Budget, via the U.S. Census Bureau",
            "the counties of every cbsa and metropolitan division on the delineation each acs vintage was published on",
            "omb february 2013, september 2018 and july 2023 delineations", len(by_vintage),
            {"vintages": sorted(VINTAGE_DELINEATIONS), "sources": VINTAGE_DELINEATIONS},
        ),
    ])
    print(f"[gazetteer] {len(cbsa)} cbsas and {len(divisions)} divisions -> {OUT_FILE.name}")
    print(f"[gazetteer] {len(membership)} cbsa county pairs -> {MEMBERSHIP_FILE.name}")
    print(f"[gazetteer] {len(by_vintage)} pairs across {by_vintage['vintage'].nunique()} vintages "
          f"-> {VINTAGE_MEMBERSHIP_FILE.name}")
    return OUT_FILE

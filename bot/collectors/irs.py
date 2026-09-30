import hashlib
import io

import pandas as pd

from bot.common import RAW_DIR, fetch, manifest_entry, staged_folder

OUT_DIR = RAW_DIR / "irs"
OUT_FILE = OUT_DIR / "metrics.csv"
URL = "https://www.irs.gov/pub/irs-soi/county{kind}{pair}.csv"
# omb's july 2023 delineation: the county makeup of every cbsa and division
DELINEATION_URL = ("https://www2.census.gov/programs-surveys/metro-micro/geographies/"
                   "reference-files/2023/delineation-files/list1_2023.xlsx")
PROVIDER = "Internal Revenue Service, Statistics of Income"

# the 2013 to 2014 filing year pair is the oldest pulled, which fills the 2014
# study panel. pairs through 2021 to 2022 are known to exist, newer ones are
# probed until the first 404
FIRST_YEAR = 2013
KNOWN_THROUGH = 2021

# every county opens with header rows whose partner state field carries a
# code instead of a state: 96 is total migration us and foreign, 97 is total
# migration us with county 0 for the whole, 1 for same state and 3 for
# different state, 98 is foreign. this collector keeps 97 with county 0
TOTAL_US_STATE = 97
TOTAL_US_COUNTY = 0

# fips state codes stop at 56. a partner state past it is a row irs adds of
# its own: 57 foreign, 58 and 59 other flows, 96 to 98 the totals above
LAST_STATE = 56

METRICS = ["irs_net_returns", "irs_net_exemptions", "irs_inflow_returns", "irs_outflow_returns"]
GROSS = ["irs_inflow_returns", "irs_outflow_returns"]
COLUMNS = ["cbsa_code", "metric", "period", "value"]
TOTAL_COLUMNS = ["county_fips", "n1", "n2"]
MOVE_COLUMNS = ["origin", "dest", "n1"]
DATASET = ("county to county migration, total us in and out migration per county "
           "summed to cbsa and metropolitan division codes")


# "1415" for the 2014 to 2015 filing year pair
def pair_label(year):
    return f"{year % 100:02d}{(year + 1) % 100:02d}"


# a pair reports under its second year
def period_of(year):
    return str(year + 1)


def _empty_totals():
    return pd.DataFrame({"county_fips": pd.Series(dtype=str),
                         "n1": pd.Series(dtype=int), "n2": pd.Series(dtype=int)})


def _empty_moves():
    return pd.DataFrame({"origin": pd.Series(dtype=str), "dest": pd.Series(dtype=str),
                         "n1": pd.Series(dtype=int)})


# the county's own fips sits on the y2 side of the inflow file (destination)
# and the y1 side of the outflow file (origin), the partner on the other.
# codes are zero padded in some years and bare in others, so they go through
# int. the six columns as numbers, own county first, or none for an empty file
def _fields(content, kind):
    own, partner = ("y2", "y1") if kind == "inflow" else ("y1", "y2")
    if content.startswith(b"\xef\xbb\xbf"):
        content = content[3:]
    try:
        df = pd.read_csv(io.BytesIO(content), dtype=str, encoding="latin-1")
    except pd.errors.EmptyDataError:
        return None
    needed = [f"{own}_statefips", f"{own}_countyfips", f"{partner}_statefips",
              f"{partner}_countyfips", "n1", "n2"]
    absent = [c for c in needed if c not in df.columns]
    if absent:
        raise ValueError(f"{kind} file is missing columns {absent}")
    return [pd.to_numeric(df[c], errors="coerce") for c in needed]


def _fips(state, county):
    return state.astype(int).astype(str).str.zfill(2) + county.astype(int).astype(str).str.zfill(3)


# keeps the total migration us row of every county and drops the state
# totals (county 0) and suppressed totals, which are -1 (fewer than 20 returns)
def parse_totals(content, kind):
    fields = _fields(content, kind)
    if fields is None:
        return _empty_totals()
    state, county, partner_state, partner_county, n1, n2 = fields
    keep = ((partner_state == TOTAL_US_STATE) & (partner_county == TOTAL_US_COUNTY)
            & (state > 0) & (county > 0) & (n1 >= 0) & (n2 >= 0))
    out = pd.DataFrame({
        "county_fips": _fips(state[keep], county[keep]),
        "n1": n1[keep].astype(int),
        "n2": n2[keep].astype(int),
    })
    # a repeated header row would double count in the merge
    return out.drop_duplicates("county_fips").reset_index(drop=True)


# the county to county rows: returns that moved from one county to another,
# keyed by the county they left and the one they entered. the rows irs adds
# of its own, the non-migrants (a county paired with itself) and suppressed
# counts go. irs prints a pair only at 20 returns or more and folds the rest
# into other flows. the 2013 to 2014 files print about a thousand pairs
# twice, and a repeat counts once
def parse_moves(content, kind):
    fields = _fields(content, kind)
    if fields is None:
        return _empty_moves()
    state, county, partner_state, partner_county, n1, _ = fields
    keep = ((state > 0) & (county > 0) & (partner_state > 0) & (partner_state <= LAST_STATE)
            & (partner_county > 0) & ~((state == partner_state) & (county == partner_county))
            & (n1 >= 0))
    own, partner = _fips(state[keep], county[keep]), _fips(partner_state[keep], partner_county[keep])
    origin, dest = (partner, own) if kind == "inflow" else (own, partner)
    out = pd.DataFrame({"origin": origin, "dest": dest, "n1": n1[keep].astype(int)})
    return out.drop_duplicates(["origin", "dest"]).reset_index(drop=True)


# net per county for one pair. a county counts only when both its inflow and
# outflow totals are known, so net always equals inflow minus outflow at
# every level of aggregation, and still does once aggregate takes the moves
# inside a code off both gross flows
def county_net(inflow, outflow):
    both = inflow.merge(outflow, on="county_fips", suffixes=("_in", "_out"))
    return pd.DataFrame({
        "county_fips": both["county_fips"],
        "irs_net_returns": both["n1_in"] - both["n1_out"],
        "irs_net_exemptions": both["n2_in"] - both["n2_out"],
        "irs_inflow_returns": both["n1_in"],
        "irs_outflow_returns": both["n1_out"],
    })


# one row per county and code it belongs to. every county row carries its
# cbsa, and a county inside a metropolitan division carries that code too.
# the sheet has two title rows above the header and note rows at the bottom
# connecticut replaced its counties with planning regions in 2023. a source
# still reporting a county has to reach the cbsa that county's region belongs
# to, or every filing year before the change joins nothing.
#
# this is an approximation and the map says so. irs publishes counties, not
# towns, so a county total cannot be split where a planning region cut it in
# half, and each county is credited whole to one region. measured on inflow
# returns across the 2021 to 2022 seam, where the filing years change from
# counties to regions with nothing else moving: bridgeport +5.4 percent,
# norwich +0.5, putnam -11.5, hartford -16.3, new haven -28.6, torrington
# -42.6. bridgeport and norwich are near enough to a whole county to carry.
#
# 47930 waterbury-shelton is naugatuck valley, 09140, alone. no county in
# this table maps to 09140, because naugatuck valley was assembled from towns
# in three of them, so 47930 has no filing year before 2022 and no county
# arithmetic can give it one. redtest_irs_connecticut holds the case open
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


def add_connecticut(crosswalk):
    codes_of = {}
    for fips, code in zip(crosswalk["county_fips"], crosswalk["cbsa_code"]):
        codes_of.setdefault(fips, set()).add(code)
    extra = [{"county_fips": county, "cbsa_code": code}
             for county, region in sorted(CONNECTICUT.items()) if county not in codes_of
             for code in sorted(codes_of.get(region, ()))]
    return pd.concat([crosswalk, pd.DataFrame(extra)], ignore_index=True) if extra else crosswalk


def parse_crosswalk(content):
    df = pd.read_excel(io.BytesIO(content), header=2, dtype=str)
    df = df[df["FIPS State Code"].notna() & df["FIPS County Code"].notna()]
    fips = (df["FIPS State Code"].str.strip().str.zfill(2)
            + df["FIPS County Code"].str.strip().str.zfill(3))
    cbsa = pd.DataFrame({"county_fips": fips, "cbsa_code": df["CBSA Code"].str.strip()})
    inside = df["Metropolitan Division Code"].notna()
    division = pd.DataFrame({"county_fips": fips[inside],
                             "cbsa_code": df.loc[inside, "Metropolitan Division Code"].str.strip()})
    return pd.concat([cbsa, division], ignore_index=True)


# the returns that moved between two counties of the same code, per code.
# only the counties county_net kept count, so a code's gross flows and its
# net are read off the same counties. a county sits in its cbsa and in its
# division, so a move between two divisions of one metro is inside the metro
# and inside neither division
def moves_inside(moves, crosswalk, counties):
    moves = moves[moves["origin"].isin(counties) & moves["dest"].isin(counties)]
    ends = (moves.merge(crosswalk.rename(columns={"county_fips": "origin"}), on="origin")
            .merge(crosswalk.rename(columns={"county_fips": "dest"}), on=["dest", "cbsa_code"]))
    return ends.groupby("cbsa_code")["n1"].sum()


# sum the county values into every code each county belongs to. a county in
# no cbsa falls out of the inner merge and a code with no usable county gets
# no row. values stay whole numbers.
#
# a county's total migration row counts a move from another county of the
# same code too, so summed to the code that move is inflow where it landed
# and outflow where it left. it cancels in the net and inflates both gross
# flows, so inside, the returns per code from moves_inside, comes off both
# and leaves inflow what came from outside the code and outflow what left
# it. the two files print each such move once, and with the same count in
# every filing year pulled, so it is read off the inflow file alone and the
# net still equals inflow minus outflow. moves under 20 returns are not
# printed pair by pair and stay in both gross flows
def aggregate(county_values, crosswalk, period, inside=None):
    joined = crosswalk.merge(county_values, on="county_fips")
    if joined.empty:
        return pd.DataFrame(columns=COLUMNS)
    totals = joined.groupby("cbsa_code", sort=True)[METRICS].sum()
    if inside is not None:
        taken = inside.reindex(totals.index, fill_value=0)
        for metric in GROSS:
            totals[metric] = totals[metric] - taken
    totals = totals.reset_index()
    long = totals.melt(id_vars="cbsa_code", value_vars=METRICS, var_name="metric", value_name="value")
    long["period"] = str(period)
    long["value"] = long["value"].astype(int)
    return long[COLUMNS].sort_values(["cbsa_code", "metric"]).reset_index(drop=True)


# what the manifest records for a file that is parsed in memory and never
# written to disk. row_count is data rows, header excluded
def file_note(name, url, content):
    return {
        "filename": name,
        "endpoint": url,
        "sha256": hashlib.sha256(content).hexdigest(),
        "size_kb": round(len(content) / 1024, 1),
        "row_count": max(len(content.splitlines()) - 1, 0),
    }


# none on a 404 so the caller can stop probing for newer pairs, any other
# failure raises
def _download(url):
    response = fetch(url)
    if response.status_code == 404:
        return None
    response.raise_for_status()
    return response.content


# both files of one pair as {kind: (url, content)}, or none when the pair
# does not exist yet
def _fetch_pair(pair):
    fetched = {}
    for kind in ("inflow", "outflow"):
        url = URL.format(kind=kind, pair=pair)
        content = _download(url)
        if content is None:
            if kind == "outflow":
                raise RuntimeError(f"countyoutflow{pair}.csv is missing while the inflow file exists")
            return None
        fetched[kind] = (url, content)
    return fetched


def collect():
    print("[irs] fetching the omb july 2023 delineation file")
    content = _download(DELINEATION_URL)
    if content is None:
        raise RuntimeError("the 2023 delineation workbook is missing")
    crosswalk = add_connecticut(parse_crosswalk(content))
    delineated = set(crosswalk["county_fips"])

    frames, files = [], []
    year = FIRST_YEAR
    while True:
        pair = pair_label(year)
        fetched = _fetch_pair(pair)
        if fetched is None:
            if year <= KNOWN_THROUGH:
                raise RuntimeError(f"countyinflow{pair}.csv is missing")
            break
        totals = {}
        for kind, (url, content) in fetched.items():
            name = f"county{kind}{pair}.csv"
            totals[kind] = parse_totals(content, kind)
            if totals[kind].empty:
                raise RuntimeError(f"{name} has no total migration rows")
            files.append(file_note(name, url, content))
            print(f"[irs] {name} {files[-1]['row_count']} rows, {len(totals[kind])} county totals")

        counties = county_net(totals["inflow"], totals["outflow"])
        inside = moves_inside(parse_moves(fetched["inflow"][1], "inflow"), crosswalk,
                              set(counties["county_fips"]))
        one_sided = len(set(totals["inflow"]["county_fips"]) ^ set(totals["outflow"]["county_fips"]))
        without = len(delineated - set(counties["county_fips"]))
        print(f"[irs] {period_of(year)}: {len(counties)} counties netted, {one_sided} dropped for a "
              f"missing side, {without} delineation counties without data, {int(inside.sum())} "
              f"returns taken off the gross flows of {len(inside)} codes")
        frames.append(aggregate(counties, crosswalk, period_of(year), inside))
        year += 1

    df = pd.concat(frames, ignore_index=True)
    last = year - 1
    with staged_folder(OUT_DIR) as landing:
        path = landing.csv(df, OUT_FILE.name)
        landing.manifest([manifest_entry(
            path, URL.format(kind="inflow", pair=pair_label(last)), PROVIDER, DATASET,
            f"through {last}-{last + 1}", len(df),
            {
                "summary_row": "partner state 97 with county 0, Total Migration-US, per county",
                "rule": "a county counts in a year only when both its inflow and outflow totals are "
                        "present and not suppressed (-1), counties sum to their cbsa and, inside a "
                        "division, to that division too",
                "gross_flows": "inflow and outflow leave out a move between two counties of the same "
                               "code, read off the county to county rows of the inflow file, so a "
                               "code's inflow came from outside it and its outflow left it. irs prints "
                               "a pair only at 20 returns or more, so smaller moves inside a code stay "
                               "in. the net is the same either way",
                "period": "the second filing year of each pair",
                "metrics": METRICS,
                "delineation": DELINEATION_URL,
                "files": files,
            },
        )])
    print(f"[irs] {len(df)} rows for {period_of(FIRST_YEAR)} through {period_of(last)} -> {OUT_FILE.name}")
    return OUT_FILE

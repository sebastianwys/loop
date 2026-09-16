# one quarterly panel, one row per metro per quarter, from the raw files under
# data/raw. every transformation is a pure function of frames so the tests can
# run it on hand made fixtures. build() reads the files and wires them
# together; running the module writes the parquet, its manifest and the four
# panel figures

import hashlib
import json
import re
import sys

import matplotlib.dates as mdates
import numpy as np
import pandas as pd

from loop import charts, spec

# the map's zillow name matching lives in the bot package at the repo root
sys.path.insert(0, str(spec.REPO_ROOT))
from bot.build_map_data import display_name, load_bls, load_fred, load_zillow, match_zillow  # noqa: E402

FHFA = "fhfa/hpi_master.csv"
BLS = "bls/laus_metro_unemployment.csv"
FRED = "fred/mortgage30us.csv"
GAZETTEER = "gazetteer/cbsa_centroids.csv"
ZILLOW = {"zhvi": "zillow/zhvi_metro.csv", "zori": "zillow/zori_metro.csv"}
MERGED = spec.REPO_ROOT / "data" / "integrated" / "hpi_census_merged.csv"

# the one fhfa series per metro: the quarterly all-transactions index
FHFA_FILTER = {"level": "MSA", "frequency": "quarterly", "hpi_type": "traditional", "hpi_flavor": "all-transactions"}

# enrichment sources and the metrics each one contributes
ENRICHMENT = {
    "pep": ["pop_estimate", "domestic_migration_rate"],
    "bps": ["permits_units"],
    "bea": ["bea_income_per_capita"],
    "realtor": ["median_listing_price"],
    "zillow_extras": ["inventory"],
}
ENRICHMENT_FEATURES = [
    "permits_per_1000", "pop_growth", "domestic_migration_rate", "income_growth", "listing_price_yoy", "inventory_yoy",
]

CENSUS_SUFFIX = re.compile(r"\s*(Metro|Micro) (Area|Division)$")
MONTH_OF_YEAR = re.compile(r"M(0[1-9]|1[0-2])")


def periods(quarters):
    return pd.PeriodIndex(np.asarray(quarters, dtype=object), freq="Q")


def quarter_dates(quarters):
    return periods(quarters).end_time.normalize()


def safe_log(values):
    values = pd.Series(np.asarray(values, dtype=float), index=getattr(values, "index", None))
    return np.log(values.where(values > 0))


# --- fhfa ---

def fhfa_series(raw):
    keep = np.ones(len(raw), dtype=bool)
    for column, wanted in FHFA_FILTER.items():
        keep &= (raw[column].astype(str) == wanted).to_numpy()
    rows = raw.loc[keep]
    out = pd.DataFrame({
        "cbsa_code": rows["place_id"].astype(str).str.zfill(5).to_numpy(),
        "quarter": (rows["yr"].astype(str) + "Q" + rows["period"].astype(str)).to_numpy(),
        "hpi": pd.to_numeric(rows["index_nsa"], errors="coerce").to_numpy(),
    })
    out = out.dropna(subset=["hpi"]).sort_values(spec.KEY).reset_index(drop=True)
    if out.duplicated(spec.KEY).any():
        raise ValueError("fhfa filter left more than one series for a metro")
    return out


# log change over a number of quarters within one metro. the earlier value is
# looked up at exactly that many quarters back in the same metro, so a gap in
# a series gives null rather than a change measured over the wrong span, and
# the first quarters of a metro never reach into another metro
def log_diff(frame, column, steps):
    codes = frame["cbsa_code"].astype(str).to_numpy()
    values = safe_log(frame[column])
    wanted = pd.DataFrame({
        "cbsa_code": codes,
        "quarter": (periods(frame["quarter"]) - steps).astype(str).to_numpy(),
        "order": np.arange(len(frame)),
    })
    known = pd.DataFrame({"cbsa_code": codes, "quarter": frame["quarter"].astype(str).to_numpy(), "earlier": values.to_numpy()})
    if known.duplicated(spec.KEY).any():
        raise ValueError("more than one row per metro and quarter")
    earlier = wanted.merge(known, on=spec.KEY, how="left").sort_values("order")["earlier"].to_numpy()
    return pd.Series(values.to_numpy() - earlier, index=frame.index)


# --- time alignment ---

# quarterly mean of the monthly rows of a bls style frame: period M01 to M12 is
# a month, M13 is the annual average and is not a month
# the mean of the months that exist, deliberately, and a month published as
# null is not a month. requiring all three was tried and is worse: the only
# short quarter in the panel is 2025Q4, where the shutdown means october was
# never published and never will be, and dropping it sends 385 metros back to
# the previous year's annual average. abilene would read 3.4, a number from
# 2024, instead of 3.30, which is november and december of the quarter itself
def quarter_mean_of_months(frame):
    period = frame["period"].astype(str)
    monthly = frame[period.str.fullmatch(MONTH_OF_YEAR).to_numpy()].dropna(subset=["value"])
    month = monthly["period"].astype(str).str[1:].astype(int)
    quarter = monthly["year"].astype(int).astype(str) + "Q" + ((month - 1) // 3 + 1).astype(str)
    grouped = monthly.assign(quarter=quarter.to_numpy()).groupby(["cbsa_code", "quarter"], as_index=False)
    return grouped["value"].mean()


# quarterly mean of dated rows, such as a weekly rate
def quarter_mean_of_dates(frame):
    quarter = pd.to_datetime(frame["date"]).dt.to_period("Q").astype(str)
    return frame.assign(quarter=quarter.to_numpy()).groupby("quarter", as_index=False)["value"].mean()


# the leakage rule. an annual value for year y is only known from the first
# quarter of y + 1, so it applies to every quarter of y + 1 and later until a
# newer year arrives. a monthly value is known in its own month and is read at
# the quarter's last month. a row therefore never sees a number that was
# published after its quarter
def annual_as_of(annual, spine):
    known = periods(spine["quarter"]).year.astype("int64") - 1
    left = pd.DataFrame({
        "cbsa_code": spine["cbsa_code"].astype(str).to_numpy(),
        "known_year": known,
        "order": np.arange(len(spine)),
    }).sort_values("known_year", kind="stable")
    right = annual[["cbsa_code", "year", "value"]].dropna(subset=["value"])
    right = right.assign(cbsa_code=right["cbsa_code"].astype(str), year=right["year"].astype("int64"))
    right = right.sort_values("year", kind="stable")
    merged = pd.merge_asof(left, right, left_on="known_year", right_on="year", by="cbsa_code", direction="backward")
    return pd.Series(merged.sort_values("order")["value"].to_numpy(), index=spine.index)


def monthly_as_of(monthly, spine):
    last_month = periods(spine["quarter"]).asfreq("M", how="end").astype(str)
    left = pd.DataFrame({"cbsa_code": spine["cbsa_code"].astype(str).to_numpy(), "month": last_month})
    right = monthly[["cbsa_code", "month", "value"]].dropna(subset=["value"])
    right = right.assign(cbsa_code=right["cbsa_code"].astype(str), month=right["month"].astype(str))
    right = right.drop_duplicates(["cbsa_code", "month"])
    merged = left.merge(right, on=["cbsa_code", "month"], how="left")
    return pd.Series(merged["value"].to_numpy(), index=spine.index)


# a metrics frame mixes yyyy and yyyy-mm periods, each row keeps its own shape
def split_periods(long):
    period = long["period"].astype(str)
    annual = long[period.str.fullmatch(r"\d{4}").to_numpy()]
    annual = annual.assign(year=annual["period"].astype(int))
    monthly = long[period.str.fullmatch(r"\d{4}-\d{2}").to_numpy()]
    monthly = monthly.assign(month=monthly["period"].astype(str))
    return annual, monthly


def as_of(long, spine):
    annual, monthly = split_periods(long)
    return monthly_as_of(monthly, spine).fillna(annual_as_of(annual, spine))


# a part keyed by metro and quarter, or by quarter alone, laid onto the spine
def attach(spine, part, on):
    if part.duplicated(on).any():
        raise ValueError(f"more than one value per {on}")
    merged = spine[on].merge(part[on + ["value"]], on=on, how="left")
    return pd.Series(merged["value"].to_numpy(), index=spine.index)


# --- enrichment features ---

def _log_change(frame, key, later):
    prior = frame[["cbsa_code", key, "value"]].rename(columns={"value": "prior"})
    prior[key] = later
    out = frame[["cbsa_code", key, "value"]].merge(prior, on=["cbsa_code", key], how="left")
    return out.assign(value=(safe_log(out["value"]) - safe_log(out["prior"])).to_numpy()).drop(columns="prior")


# year over year change of an annual series, the prior year has to exist
def annual_log_change(annual):
    return _log_change(annual, "year", annual["year"].astype(int).to_numpy() + 1)


# change over twelve months of a monthly series
def monthly_log_change(monthly, months=12):
    later = (pd.PeriodIndex(np.asarray(monthly["month"], dtype=object), freq="M") + months).astype(str)
    return _log_change(monthly, "month", later.to_numpy())


def _metric(frame, metric, key):
    return frame.loc[frame["metric"] == metric, ["cbsa_code", key, "value"]].reset_index(drop=True)


# the derived features as one long frame with the metrics.csv shape, so that
# inheritance and alignment treat every feature alike
def enrichment_features(metrics):
    annual, monthly = split_periods(metrics)
    permits = _metric(annual, "permits_units", "year").merge(
        _metric(annual, "pop_estimate", "year"), on=["cbsa_code", "year"], suffixes=("", "_pop"))
    permits["value"] = permits["value"] / permits["value_pop"].where(permits["value_pop"] > 0) * 1000.0
    yearly = {
        "permits_per_1000": permits,
        "pop_growth": annual_log_change(_metric(annual, "pop_estimate", "year")),
        "domestic_migration_rate": _metric(annual, "domestic_migration_rate", "year"),
        "income_growth": annual_log_change(_metric(annual, "bea_income_per_capita", "year")),
        "listing_price_yoy": annual_log_change(_metric(annual, "median_listing_price", "year")),
        "inventory_yoy": annual_log_change(_metric(annual, "inventory", "year")),
    }
    by_month = {
        "listing_price_yoy": monthly_log_change(_metric(monthly, "median_listing_price", "month")),
        "inventory_yoy": monthly_log_change(_metric(monthly, "inventory", "month")),
    }
    rows = [f.assign(metric=name, period=f["year"].astype(int).astype(str)) for name, f in yearly.items()]
    rows += [f.assign(metric=name, period=f["month"].astype(str)) for name, f in by_month.items()]
    out = pd.concat(rows, ignore_index=True)[["cbsa_code", "metric", "period", "value"]]
    return out.dropna(subset=["value"]).reset_index(drop=True)


# a division with no rows at all for a metric takes its parent metro's rows for
# it, the way the map fills the division panels. derived rates are inherited,
# never counts, so a division is not handed the parent's permits over its own
# population
# all or nothing per metric, and deliberately so. a division that holds part of
# a metric keeps only its own rows: the parent is a different, larger geography,
# so filling its missing years from the parent splices two scales into one
# series. gary in holds 718,960 people from 2020 and its parent chicago holds
# 9,435,971, thirteen times more, so a year by year fill would hand gary a
# minus 257 percent population growth at the seam. the nulls are the honest
# answer, and the map discloses a whole metric taken from a parent
def inherit_from_parent(long, parents):
    filled = [long]
    for division, parent in parents.items():
        own = set(long.loc[long["cbsa_code"] == division, "metric"])
        rows = long[(long["cbsa_code"] == parent) & ~long["metric"].isin(own)]
        if len(rows):
            filled.append(rows.assign(cbsa_code=division))
    return pd.concat(filled, ignore_index=True)


def parents_of(gazetteer):
    rows = gazetteer.dropna(subset=["parent_cbsa"])
    return {str(code): str(parent) for code, parent in zip(rows["cbsa_code"], rows["parent_cbsa"])}


# --- names, levels, zillow ---

def static_columns(codes, gazetteer):
    table = gazetteer.drop_duplicates("cbsa_code").set_index("cbsa_code")
    out = pd.DataFrame({"cbsa_code": pd.Series(np.asarray(codes, dtype=object), dtype=str)})
    out["name"] = out["cbsa_code"].map(table["name"]).str.replace(CENSUS_SUFFIX, "", regex=True)
    division = out["cbsa_code"].map(table["cbsa_type"]).astype(str) == "3"
    out["level"] = np.where(division, "division", "msa")
    out["parent_cbsa"] = out["cbsa_code"].map(table["parent_cbsa"]).where(division)
    return out


# zillow publishes metros under the first city and state, so the fhfa place
# name is tried exact, then first city, then the first two cities, as the map
# does. a division takes its parent metro's series
def zillow_lookup(metros, gazetteer, wide):
    names = gazetteer.drop_duplicates("cbsa_code").set_index("cbsa_code")["name"]
    lookup = {}
    for row in metros.itertuples(index=False):
        if row.level == "division":
            parent = None if pd.isna(row.parent_cbsa) else str(row.parent_cbsa)
            target = CENSUS_SUFFIX.sub("", str(names[parent])) if parent in names.index else None
        else:
            target = display_name(row.place_name)
        match = match_zillow(target, wide)
        if match is not None:
            lookup[str(row.cbsa_code)] = match.name
    return lookup


# the wide zillow frame as long monthly rows keyed by cbsa code
def zillow_long(wide, lookup):
    keyed = pd.DataFrame({"cbsa_code": list(lookup), "region": list(lookup.values())})
    rows = wide.loc[keyed["region"].unique()].copy()
    rows.columns = pd.to_datetime(rows.columns).to_period("M").astype(str)
    long = rows.rename_axis("region").reset_index().melt(id_vars="region", var_name="month", value_name="value")
    long = long.dropna(subset=["value"]).merge(keyed, on="region")
    return long[["cbsa_code", "month", "value"]].reset_index(drop=True)


# --- unemployment ---

# the bls collector keeps the annual averages plus the newest month, so most
# quarters have no months to average. those take the latest annual average
# under the annual rule: a year's average is known from the next january
def unemployment(bls, spine):
    quarterly = attach(spine, quarter_mean_of_months(bls), spec.KEY)
    annual = bls.loc[bls["period"].astype(str) == "M13", ["cbsa_code", "year", "value"]]
    return quarterly.fillna(annual_as_of(annual, spine))


# --- assembly ---

def sources(raw_dir=spec.RAW_DIR):
    files = {"fhfa": FHFA, "bls": BLS, "fred": FRED, "gazetteer": GAZETTEER, **ZILLOW}
    files.update({source: f"{source}/metrics.csv" for source in ENRICHMENT})
    return {name: {"path": f"data/raw/{rel}", "present": (raw_dir / rel).exists()} for name, rel in files.items()}


def read_metrics(raw_dir, have):
    frames = []
    for source, metrics in ENRICHMENT.items():
        if not have[source]["present"]:
            continue
        frame = pd.read_csv(raw_dir / source / "metrics.csv", dtype={"cbsa_code": str, "metric": str, "period": str})
        frame = frame[frame["metric"].isin(metrics)]
        frame = frame.assign(cbsa_code=frame["cbsa_code"].str.zfill(5), value=pd.to_numeric(frame["value"], errors="coerce"))

        # a file on disk that hands back nothing for a metric it declares would
        # leave the feature it feeds null in every row, while the manifest still
        # called the source present. that is a break, so say it here
        arrived = set(frame.loc[frame["value"].notna(), "metric"])
        bare = [metric for metric in metrics if metric not in arrived]
        if bare:
            raise ValueError(f"{source}/metrics.csv is on disk with no usable rows for {bare}")

        frames.append(frame[["cbsa_code", "metric", "period", "value"]])
    if not frames:
        return pd.DataFrame({"cbsa_code": pd.Series(dtype=str), "metric": pd.Series(dtype=str),
                             "period": pd.Series(dtype=str), "value": pd.Series(dtype=float)})
    return pd.concat(frames, ignore_index=True)


def contract(panel):
    missing = [c for c in spec.PANEL_COLUMNS if c not in panel.columns]
    extra = [c for c in panel.columns if c not in spec.PANEL_COLUMNS]
    if missing or extra:
        raise ValueError(f"panel columns off the contract, missing {missing}, extra {extra}")
    out = panel[spec.PANEL_COLUMNS]
    assert list(out.columns) == spec.PANEL_COLUMNS
    return out


def build(raw_dir=spec.RAW_DIR):
    have = sources(raw_dir)
    panel = fhfa_series(pd.read_csv(raw_dir / FHFA, dtype=str))
    panel["log_hpi"] = safe_log(panel["hpi"])
    panel["hpi_qoq"] = log_diff(panel, "hpi", 1)
    panel["hpi_yoy"] = log_diff(panel, "hpi", 4)

    gazetteer = pd.read_csv(raw_dir / GAZETTEER, dtype=str)
    panel = panel.merge(static_columns(panel["cbsa_code"].unique(), gazetteer), on="cbsa_code", how="left")
    panel["date"] = quarter_dates(panel["quarter"])
    spine = panel[spec.KEY]

    panel["unemp"] = unemployment(load_bls(raw_dir / BLS), spine) if have["bls"]["present"] else np.nan
    if have["fred"]["present"]:
        panel["mortgage"] = attach(spine, quarter_mean_of_dates(load_fred(raw_dir / FRED)), ["quarter"])
    else:
        panel["mortgage"] = np.nan

    # the fhfa place names carry the zillow match, a division through its
    # parent. without the merged csv the gazetteer name, minus its census
    # suffix, has the same shape
    metros = static_columns(panel["cbsa_code"].unique(), gazetteer)
    if MERGED.exists():
        merged = pd.read_csv(MERGED, dtype=str)[["cbsa_code", "place_name"]].drop_duplicates("cbsa_code")
        metros = metros.merge(merged, on="cbsa_code", how="left")
        metros["place_name"] = metros["place_name"].fillna(metros["name"])
    else:
        metros["place_name"] = metros["name"]
    for column, rel in ZILLOW.items():
        if have[column]["present"]:
            wide = load_zillow(raw_dir / rel)
            panel[column] = monthly_as_of(zillow_long(wide, zillow_lookup(metros, gazetteer, wide)), spine)
        else:
            panel[column] = np.nan
        panel[f"{column}_yoy"] = log_diff(panel, column, 4)

    features = inherit_from_parent(enrichment_features(read_metrics(raw_dir, have)), parents_of(gazetteer))
    for name in ENRICHMENT_FEATURES:
        panel[name] = as_of(features[features["metric"] == name], spine)
    check_features(panel, have)

    return contract(panel.sort_values(spec.KEY).reset_index(drop=True))


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# what a missing source costs, for the manifest
ABSENT = {
    "bls": ["unemp"], "fred": ["mortgage"], "zhvi": ["zhvi", "zhvi_yoy"], "zori": ["zori", "zori_yoy"],
    "pep": ["pop_growth", "domestic_migration_rate", "permits_per_1000"], "bps": ["permits_per_1000"],
    "bea": ["income_growth"], "realtor": ["listing_price_yoy"], "zillow_extras": ["inventory_yoy"],
}


# which enrichment sources feed a derived feature, read back off ABSENT so the
# two cannot drift apart
def feeders(feature):
    return [source for source in ENRICHMENT if feature in ABSENT.get(source, [])]


# a feature null in every row while every source behind it is on disk means the
# rows arrived and never joined. the panel is 71,072 rows, nobody reads a column
# of nulls off the end of a build, so it stops here
def check_features(panel, have):
    for name in ENRICHMENT_FEATURES:
        behind = feeders(name)
        if panel[name].isna().all() and all(have[source]["present"] for source in behind):
            raise ValueError(f"{name} is null in every row while {behind} are on disk")


# a path as the manifest may name it: inside the repo, never a machine path
def relative(path):
    return str(path.relative_to(spec.REPO_ROOT)) if spec.REPO_ROOT in path.parents else path.name


def manifest(panel, path, have):
    missing = [name for name, info in have.items() if not info["present"]]
    return {
        "parquet": relative(path),
        "sha256": sha256(path),
        "rows": int(len(panel)),
        "metros": int(panel["cbsa_code"].nunique()),
        "first_quarter": str(panel["quarter"].min()),
        "last_quarter": str(panel["quarter"].max()),
        "non_null_share": {c: round(float(panel[c].notna().mean()), 4) for c in spec.PANEL_COLUMNS},
        "sources": {name: info["path"] for name, info in have.items() if info["present"]},
        "missing_sources": {name: f"{have[name]['path']} is absent, so {', '.join(ABSENT.get(name, []))} stay null"
                            for name in missing},
    }


def write(panel, path=spec.PANEL_PATH, manifest_path=spec.PANEL_MANIFEST, have=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    panel.to_parquet(path, index=False)
    info = manifest(panel, path, have if have is not None else sources())
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(info, indent=2) + "\n")
    return info


# --- figures ---

COVERAGE = [
    ("hpi", "hpi"), ("unemp", "unemp"), ("mortgage", "mortgage"), ("zhvi", "zhvi"), ("zori", "zori"),
    ("permits", "permits_per_1000"), ("population", "pop_growth"), ("income", "income_growth"),
    ("listings", "listing_price_yoy"), ("inventory", "inventory_yoy"),
]
GROWTH = ["hpi_qoq", "hpi_yoy", "zhvi_yoy", "zori_yoy", "pop_growth", "income_growth", "listing_price_yoy", "inventory_yoy"]
RATES = ["unemp", "mortgage"]


# share of metros with a value in each year, one row per source series
def coverage_table(panel):
    year = panel["quarter"].astype(str).str[:4].astype(int)
    years = range(year.min(), year.max() + 1)
    metros = panel["cbsa_code"].nunique()
    rows = {}
    for label, column in COVERAGE:
        has = panel[column].notna().to_numpy()
        counted = panel.loc[has, "cbsa_code"].groupby(year[has].to_numpy()).nunique()
        rows[label] = counted.reindex(years, fill_value=0) / metros
    return pd.DataFrame(rows).T


def coverage_figure(panel):
    table = coverage_table(panel) * 100.0
    latest, metros = panel["quarter"].max(), panel["cbsa_code"].nunique()
    fig, ax = charts.figure(
        "Where the panel has data",
        f"share of the {metros} metros with a value in each year, one row per source series, as of {latest}",
        size=(11, 6))
    years = table.columns.to_numpy(dtype=float)
    x = np.append(years, years[-1] + 1) - 0.5
    y = np.arange(len(table) + 1)
    mesh = ax.pcolormesh(x, y, table.to_numpy(), cmap=charts.sequential_cmap(), vmin=0, vmax=100,
                         edgecolors=charts.SURFACE, linewidth=0.6)
    ax.invert_yaxis()
    ax.set_yticks(y[:-1] + 0.5, table.index)
    ticks = [int(v) for v in years if v % 5 == 0]
    ax.set_xticks(ticks, [str(v) for v in ticks])
    ax.grid(False)
    ax.tick_params(length=0)
    for side in ax.spines.values():
        side.set_visible(False)
    bar = fig.colorbar(mesh, ax=ax, fraction=0.03, pad=0.02)
    bar.outline.set_visible(False)
    charts.pct_axis(bar.ax)
    bar.set_label("share of metros", color=charts.INK2)
    return charts.save(fig, "01_coverage")


# every metro's index rebased so that the base quarter reads 100
def rebased(panel, base="2000Q1", start="1990Q1"):
    at_base = panel.loc[panel["quarter"] == base].set_index("cbsa_code")["hpi"]
    frame = panel.loc[panel["quarter"] >= start, ["cbsa_code", "quarter", "date", "hpi"]].copy()
    frame["index"] = 100.0 * frame["hpi"] / frame["cbsa_code"].map(at_base)
    return frame.dropna(subset=["index"]).reset_index(drop=True)


# positions pushed apart until none sit closer than gap, each crowded pair
# giving way equally so a cluster stays centered on where it started
def spread(values, gap, rounds=100):
    values = np.asarray(values, dtype=float)
    order = np.argsort(values, kind="stable")
    placed = values[order].copy()
    for _ in range(rounds):
        moved = False
        for i in range(1, len(placed)):
            deficit = gap - (placed[i] - placed[i - 1])
            if deficit > 1e-9:
                placed[i - 1] -= deficit / 2.0
                placed[i] += deficit / 2.0
                moved = True
        if not moved:
            break
    out = np.empty_like(placed)
    out[order] = placed
    return out


# direct labels at the right end of each line, spread apart in points so none
# overlap. the marker stays on the line, only the text is offset
def end_labels(fig, ax, ends, gap=9.5):
    lo, hi = ax.get_ylim()
    height = ax.get_position().height * fig.get_figheight() * 72.0
    points = np.array([(y - lo) / (hi - lo) * height for _, y, _, _ in ends])
    placed = spread(points, gap)
    for (x, y, text, color), before, after in zip(ends, points, placed):
        charts.label_end(ax, x, y, text, color)
        ax.texts[-1].xyann = (5, after - before)


def showcase_present(panel):
    codes = set(panel["cbsa_code"])
    return [(code, label) for code, label in spec.SHOWCASE.items() if code in codes][:len(charts.SERIES)]


def hpi_history_figure(panel):
    frame = rebased(panel)
    latest, metros = panel["quarter"].max(), frame["cbsa_code"].nunique()
    named = showcase_present(panel)
    fig, ax = charts.figure(
        "House prices since 1990, named metros against the median",
        f"fhfa all-transactions index rebased to 100 in 2000Q1, {len(named)} named metros and the median of "
        f"{metros} metros, 1990Q1 to {latest}",
        size=(10, 6))
    median = frame.groupby("date")["index"].median()
    ax.plot(median.index, median.to_numpy(), color=charts.MUTED, linewidth=2.6, zorder=2)
    ends = [(median.index[-1], float(median.iloc[-1]), "median", charts.MUTED)]
    for color, (code, label) in zip(charts.SERIES, named):
        series = frame[frame["cbsa_code"] == code].sort_values("quarter")
        ax.plot(series["date"], series["index"], color=color, linewidth=1.3, zorder=3)
        ends.append((series["date"].iloc[-1], float(series["index"].iloc[-1]), label, color))
    end_labels(fig, ax, ends)
    ax.xaxis.set_major_locator(mdates.YearLocator(5))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
    ax.set_ylabel("index, 2000Q1 = 100")
    return charts.save(fig, "02_hpi_history")


# median and interquartile range across metros by quarter, quarters with too
# few metros reporting left out
def feature_bands(panel, column, minimum=50):
    grouped = panel.groupby("date")[column]
    stats = grouped.quantile([0.25, 0.5, 0.75]).unstack()
    stats.columns = ["lo", "mid", "hi"]
    stats["count"] = grouped.count()
    return stats[stats["count"] >= minimum]


def feature_trends_figure(panel):
    latest = panel["quarter"].max()
    fig, axes = charts.figure(
        "How each feature moved across metros",
        f"median across metros as the line, interquartile range as the band, quarters with at least 50 metros, "
        f"through {latest}; growth features in percent",
        size=(11, 11.5), rows=4, cols=3, gridspec_kw={"hspace": 0.62, "wspace": 0.32})
    fig.subplots_adjust(top=0.9)
    for ax, column in zip(axes.ravel(), spec.FEATURES):
        stats = feature_bands(panel, column)
        scale = spec.pct if column in GROWTH else (lambda v: np.asarray(v, dtype=float))
        ax.fill_between(stats.index, scale(stats["lo"]), scale(stats["hi"]), color=charts.BAND, linewidth=0)
        ax.plot(stats.index, scale(stats["mid"]), color=charts.SERIES[0], linewidth=1.3)
        ax.set_title(column)
        if column in GROWTH or column in RATES:
            ticks = ax.get_yticks()
            charts.pct_axis(ax, decimals=0 if np.allclose(ticks, np.round(ticks)) else 1)
        if len(stats):
            years = (stats.index[-1] - stats.index[0]).days / 365.25
            ax.xaxis.set_major_locator(mdates.YearLocator(10 if years > 30 else 5 if years > 12 else 2))
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
    return charts.save(fig, "03_feature_trends")


def snapshot_table(panel, column="hpi_yoy", count=15):
    latest = panel["quarter"].max()
    rows = panel.loc[(panel["quarter"] == latest) & panel[column].notna(), ["cbsa_code", "name", column]]
    rows = rows.sort_values(column, ascending=False).reset_index(drop=True)
    return latest, len(rows), rows.head(count), rows.tail(count)


def latest_snapshot_figure(panel):
    latest, total, top, bottom = snapshot_table(panel)
    names = top["name"].tolist() + [""] + bottom["name"].tolist()
    values = np.concatenate([spec.pct(top["hpi_yoy"]), [np.nan], spec.pct(bottom["hpi_yoy"])])
    y = np.arange(len(names))
    fig, ax = charts.figure(
        "House prices over the last year, the strongest and weakest metros",
        f"year over year change in the fhfa all-transactions index, {len(top)} highest and {len(bottom)} lowest of "
        f"{total} metros, {latest}",
        size=(9, 9.5))
    colors = [charts.SERIES[0] if v >= 0 else charts.SERIES[7] for v in np.nan_to_num(values)]
    ax.barh(y, np.nan_to_num(values), color=colors, height=0.62, zorder=3)
    ax.axvline(0, color=charts.AXIS, linewidth=0.8, zorder=2)
    ax.axhline(len(top), color=charts.GRID, linewidth=0.6)
    ax.set_yticks(y, names)
    ax.invert_yaxis()
    ax.grid(False)
    ax.grid(True, axis="x")
    ax.tick_params(axis="y", length=0)
    ax.spines["left"].set_visible(False)
    for position, value in zip(y, values):
        if np.isnan(value):
            continue
        ax.annotate(f"{value:+.1f}%", (value, position), xytext=(4 if value >= 0 else -4, 0),
                    textcoords="offset points", ha="left" if value >= 0 else "right", va="center",
                    fontsize=8, color=charts.INK2)
    lo, hi = float(np.nanmin(values)), float(np.nanmax(values))
    pad = 0.18 * max(hi - lo, 1.0)
    ax.set_xlim(min(lo, 0.0) - pad, max(hi, 0.0) + pad)
    charts.pct_axis(ax, axis="x")
    return charts.save(fig, "04_latest_snapshot")


def figures(panel):
    return [coverage_figure(panel), hpi_history_figure(panel), feature_trends_figure(panel), latest_snapshot_figure(panel)]


def main():
    have = sources()
    panel = build()
    info = write(panel, have=have)
    paths = figures(panel)
    print(f"panel: {info['rows']} rows, {info['metros']} metros, {info['first_quarter']} to {info['last_quarter']}")
    print(f"parquet: {info['parquet']} sha256 {info['sha256'][:12]}")
    for name in info["missing_sources"]:
        print(f"missing: {info['missing_sources'][name]}")
    for path in paths:
        print(f"figure: {path.relative_to(spec.REPO_ROOT)}")


if __name__ == "__main__":
    main()

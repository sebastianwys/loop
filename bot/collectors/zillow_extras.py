import hashlib
import io
import re

import pandas as pd

from bot.build_map_data import MIN_YEAR_SHARE, zillow_candidates
from bot.collectors.gazetteer import OUT_FILE as CENTROIDS
from bot.common import RAW_DIR, fetch, looks_like_csv, manifest_entry, write_csv, write_manifest

OUT_DIR = RAW_DIR / "zillow_extras"
OUT_FILE = OUT_DIR / "metrics.csv"
CATALOG = "https://www.zillow.com/research/data/"
BASE = "https://files.zillowstatic.com/research/public_csvs"

# metro level, smoothed. the first three are month histories, the forecast
# file is one base date with a few horizon columns
FILES = {
    "inventory": (
        f"{BASE}/invt_fs/Metro_invt_fs_uc_sfrcondo_sm_month.csv",
        "For sale inventory, all homes, smoothed, monthly, metro, count of listings",
    ),
    "days_to_pending": (
        f"{BASE}/mean_doz_pending/Metro_mean_doz_pending_uc_sfrcondo_sm_month.csv",
        "Mean days to pending, all homes, smoothed, monthly, metro, days",
    ),
    "price_cut_share": (
        f"{BASE}/perc_listings_price_cut/Metro_perc_listings_price_cut_uc_sfrcondo_sm_month.csv",
        "Share of listings with a price cut, all homes, smoothed, monthly, metro, fraction",
    ),
    "zhvf_forecast": (
        f"{BASE}/zhvf_growth/Metro_zhvf_growth_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
        "ZHVF one year home value growth forecast, mid tier, smoothed, seasonally adjusted, metro, percent",
    ),
}
FORECAST = "zhvf_forecast"
FORECAST_MONTHS = 12

COLUMNS = ["cbsa_code", "metric", "period", "value"]
# zillow monthly columns look like 2024-01-31
MONTH = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ATTRIBUTION = "Data provided by Zillow Research (zillow.com/research/data). Zillow terms of use apply."


# one row per zillow metro keyed by its name. the national row goes and a
# repeated name keeps its first row. index_col=False stops pandas from reading
# a long first line as extra index columns, which would shift every column;
# a long line loses its trailing fields and a short one is padded instead
def load_frame(content):
    df = pd.read_csv(io.BytesIO(content), dtype={"RegionName": str, "RegionType": str}, index_col=False)
    if "RegionName" not in df.columns:
        raise ValueError("zillow csv has no RegionName column")
    if "RegionType" in df.columns:
        df = df[df["RegionType"] != "country"]
    df = df[df["RegionName"].notna() & ~df["RegionName"].duplicated()]
    return df.set_index("RegionName")


# gazetteer metros and micros as (code, name) with the census suffix removed.
# divisions stay out, zillow publishes metros only
def metro_names(centroids):
    keep = centroids[pd.to_numeric(centroids["cbsa_type"], errors="coerce").isin([1, 2])]
    names = keep["name"].astype(str).str.replace(r"\s*(Metro|Micro) Area$", "", regex=True).str.strip()
    return list(zip(keep["cbsa_code"].astype(str), names))


# zillow name -> cbsa code. each gazetteer name tries its candidates in order
# and the first one zillow knows decides. a name an earlier code already
# claimed stays with that code
def match_names(gazetteer, zillow_names):
    known = set(zillow_names)
    mapping = {}
    for code, name in gazetteer:
        hit = next((c for c in zillow_candidates(name) if c in known), None)
        if hit is not None and hit not in mapping:
            mapping[hit] = code
    return mapping


# the month columns of a file, which are the calendar that source published
def month_columns(frame):
    return [c for c in frame.columns if MONTH.match(str(c))]


# the month columns of one file as long rows keyed by cbsa code. names with
# no code and empty cells are dropped
def monthly_rows(frame, mapping):
    months = month_columns(frame)
    keep = frame.loc[frame.index.isin(list(mapping)), months].apply(pd.to_numeric, errors="coerce")
    long = keep.rename_axis("RegionName").reset_index()
    long = long.melt(id_vars="RegionName", var_name="month", value_name="value").dropna(subset=["value"])
    long.insert(0, "cbsa_code", long["RegionName"].map(mapping))
    return long[["cbsa_code", "month", "value"]].reset_index(drop=True)


# annual means over the months present in each year, plus the newest month.
# period is yyyy for a year and yyyy-mm for the month. months is the calendar
# the source published, the denominator build_map_data.zillow_annual divides
# by: a metro holding less than MIN_YEAR_SHARE of a year has no mean for it
def summarize(long, metric, months):
    long = long.dropna(subset=["value"])
    if long.empty:
        return pd.DataFrame(columns=COLUMNS)
    published = pd.Series([str(m)[:4] for m in months], dtype=str).value_counts()
    year = long["month"].astype(str).str[:4].rename("period")
    annual = long.groupby([long["cbsa_code"], year])["value"].agg(["mean", "count"]).reset_index()
    annual = annual[annual["count"] >= annual["period"].map(published) * MIN_YEAR_SHARE]
    annual = annual.rename(columns={"mean": "value"}).drop(columns="count")
    last = long.sort_values("month", kind="stable").groupby("cbsa_code").tail(1)
    newest = pd.DataFrame({
        "cbsa_code": last["cbsa_code"],
        "period": last["month"].astype(str).str[:7],
        "value": last["value"],
    })
    out = pd.concat([annual, newest], ignore_index=True)
    out.insert(1, "metric", metric)
    out["value"] = out["value"].astype(float).round(4)
    return out[COLUMNS].sort_values(["cbsa_code", "period"], kind="stable").reset_index(drop=True)


# the forecast file carries a base date per row and a few horizon columns. the
# value one year past the base date is kept, dated by the base month
def forecast_rows(frame, mapping, metric=FORECAST):
    if "BaseDate" not in frame.columns:
        return pd.DataFrame(columns=COLUMNS)
    months = {str(c)[:7]: c for c in frame.columns if MONTH.match(str(c))}
    base = pd.to_datetime(frame["BaseDate"], format="%Y-%m-%d", errors="coerce")
    target = (base + pd.DateOffset(months=FORECAST_MONTHS)).dt.strftime("%Y-%m")
    rows = []
    for position, (name, base_month, target_month) in enumerate(zip(frame.index, base.dt.strftime("%Y-%m"), target)):
        code, column = mapping.get(name), months.get(target_month)
        if code is None or column is None:
            continue
        value = pd.to_numeric(frame[column].iloc[position], errors="coerce")
        if pd.notna(value):
            rows.append((code, metric, base_month, round(float(value), 4)))
    return pd.DataFrame(rows, columns=COLUMNS).sort_values("cbsa_code", kind="stable").reset_index(drop=True)


# the metrics the archive on disk already carries. empty when there is none,
# which is what makes skipping a source fine on a first run
def archived_metrics(path):
    if not path.exists():
        return set()
    try:
        return set(pd.read_csv(path, usecols=["metric"])["metric"].dropna())
    except (ValueError, pd.errors.EmptyDataError):
        return set()


def collect():
    centroids = pd.read_csv(CENTROIDS, dtype={"cbsa_code": str})
    gazetteer = metro_names(centroids)

    frames, files, skipped = {}, {}, []
    for metric, (url, dataset) in FILES.items():
        print(f"[zillow_extras] fetching {metric}")
        response = fetch(url)
        if response.status_code != 200 or not looks_like_csv(response.content):
            print(f"[zillow_extras] {metric} skipped, HTTP {response.status_code} from {url.rsplit('/', 1)[-1]}")
            skipped.append(metric)
            continue
        content = response.content
        frames[metric] = load_frame(content)
        # the last header column is the newest month, or the longest horizon
        # in the forecast file
        newest = content.split(b"\n", 1)[0].decode("utf-8", "replace").strip().rsplit(",", 1)[-1]
        files[metric] = {
            "url": url,
            "dataset": dataset,
            "sha256": hashlib.sha256(content).hexdigest(),
            "size_kb": round(len(content) / 1024, 1),
            "rows": int(len(frames[metric])),
            "newest_column": newest,
        }
        if metric == FORECAST:
            files[metric]["base_date"] = str(frames[metric]["BaseDate"].iloc[0]) if len(frames[metric]) else None
        print(f"[zillow_extras] {len(frames[metric])} metros through {newest} -> {metric}")

    if not frames:
        raise RuntimeError("zillow_extras: none of the zillow files could be fetched")

    names = set().union(*(set(frame.index) for frame in frames.values()))
    mapping = match_names(gazetteer, names)

    parts = []
    for metric, frame in frames.items():
        rows = (forecast_rows(frame, mapping, metric) if metric == FORECAST
                else summarize(monthly_rows(frame, mapping), metric, month_columns(frame)))
        if len(rows):
            parts.append(rows)
    df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=COLUMNS)

    monthly_newest = [info["newest_column"] for metric, info in files.items() if metric != FORECAST]
    version = f"through {max(monthly_newest)}" if monthly_newest else f"forecast base {files[FORECAST]['base_date']}"

    # metrics.csv is replaced whole, so a pull that lost a file would drop that
    # metric from every metro. skipping a source is fine, losing one the archive
    # already carries is not
    lost = archived_metrics(OUT_FILE) - set(df["metric"])
    if lost:
        raise RuntimeError(
            f"zillow_extras: this pull has no {', '.join(sorted(lost))}, "
            "refusing to replace metrics.csv with a partial one"
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_csv(df, OUT_FILE)
    write_manifest(OUT_DIR, [manifest_entry(
        OUT_FILE, CATALOG, "Zillow Research",
        "Metro inventory, days to pending, price cut share and one year ZHVF growth, annual means plus the newest month",
        version, len(df),
        {
            "attribution": ATTRIBUTION,
            "processing": "raw csvs read in memory and not kept, names mapped to cbsa codes through the gazetteer",
            "files": files,
            "skipped": skipped,
            "forecast_horizon_months": FORECAST_MONTHS,
            "gazetteer_metros": len(gazetteer),
            "gazetteer_metros_matched": len(mapping),
            "zillow_metros": len(names),
            "zillow_metros_unmatched": len(names) - len(mapping),
        },
    )])
    print(f"[zillow_extras] {len(df)} rows for {df['metric'].nunique()} metrics, "
          f"{len(mapping)} of {len(gazetteer)} gazetteer metros matched, "
          f"{len(names) - len(mapping)} zillow metros unmatched -> {OUT_FILE.name}")
    return OUT_FILE

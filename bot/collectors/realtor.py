import hashlib
import io

import pandas as pd

from bot.common import RAW_DIR, fetch, manifest_entry, staged_folder

OUT_DIR = RAW_DIR / "realtor"
OUT_FILE = OUT_DIR / "metrics.csv"
URL = ("https://econdata.s3-us-west-2.amazonaws.com/Reports/Core/"
       "RDC_Inventory_Core_Metrics_Metro_History.csv")
ATTRIBUTION = "Realtor.com Economic Research, realtor.com/research/data"

# source column -> metric name for the three values copied as published
COPIED = {
    "median_listing_price": "median_listing_price",
    "active_listing_count": "active_listings",
    "median_days_on_market": "days_on_market",
}
# the share is derived here from two published counts, month by month
SHARE = "price_reduced_share"
NUMERATOR, DENOMINATOR = "price_reduced_count", "total_listing_count"
METRICS = list(COPIED.values()) + [SHARE]
COLUMNS = ["cbsa_code", "metric", "period", "value"]


# one row per metro and month: the five digit code, the period as yyyy-mm,
# the four metrics as floats and whether realtor.com flagged the month.
# rows without a six digit month, such as the trailing summary line, are
# dropped, and the first row wins when a month repeats
def parse_history(text):
    df = pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False).fillna("")
    month = df["month_date_yyyymm"].str.strip()
    code = df["cbsa_code"].str.strip()
    keep = month.str.fullmatch(r"\d{6}") & code.str.fullmatch(r"\d+")
    df, month, code = df[keep], month[keep], code[keep]

    out = pd.DataFrame({
        "cbsa_code": code.str.zfill(5),
        "period": month.str[:4] + "-" + month.str[4:],
    })
    for source, metric in COPIED.items():
        out[metric] = pd.to_numeric(df[source], errors="coerce").astype(float)
    numerator = pd.to_numeric(df[NUMERATOR], errors="coerce")
    denominator = pd.to_numeric(df[DENOMINATOR], errors="coerce")
    out[SHARE] = numerator / denominator.where(denominator > 0)
    flag = df["quality_flag"] if "quality_flag" in df.columns else pd.Series("", index=df.index)
    out["flagged"] = pd.to_numeric(flag, errors="coerce").eq(1)
    return out.drop_duplicates(["cbsa_code", "period"]).reset_index(drop=True)


# the calendar years present in all twelve months
def full_years(periods):
    months = pd.Series(list(periods), dtype=str).drop_duplicates()
    counts = months.str[:4].value_counts()
    return sorted(int(year) for year, n in counts.items() if n == 12)


# annual means over the months of every full year, plus the newest month
# that has a value, per metro and metric, in the shape the map builder reads
def summarize(df):
    years = [str(year) for year in full_years(df["period"])]
    long = df.melt(id_vars=["cbsa_code", "period"], value_vars=METRICS,
                   var_name="metric", value_name="value")
    long = long.dropna(subset=["value"]).sort_values(["cbsa_code", "metric", "period"], kind="stable")

    year = long["period"].str[:4]
    in_full = year.isin(years)
    annual = long[in_full].assign(period=year[in_full])
    annual = annual.groupby(["cbsa_code", "metric", "period"], as_index=False)["value"].mean()
    newest = long.drop_duplicates(["cbsa_code", "metric"], keep="last")

    out = pd.concat([annual[COLUMNS], newest[COLUMNS]], ignore_index=True)
    out["value"] = out["value"].astype(float).round(4)
    return out.sort_values(["cbsa_code", "metric", "period"], kind="stable").reset_index(drop=True)


def collect():
    filename = URL.rsplit("/", 1)[-1]
    print(f"[realtor] fetching {filename}")
    response = fetch(URL)
    response.raise_for_status()
    content = response.content

    history = parse_history(content.decode("utf-8", errors="replace"))
    if not len(history):
        raise RuntimeError("realtor file has no data rows")
    metrics = summarize(history)
    years = full_years(history["period"])
    newest = history["period"].max()

    # the raw file is not kept, so its fingerprint travels in the notes
    with staged_folder(OUT_DIR) as landing:
        path = landing.csv(metrics, OUT_FILE.name)
        landing.manifest([manifest_entry(
            path, URL, "Realtor.com Economic Research",
            "Inventory core metrics, metro history: monthly listing price, active listings, "
            "days on market and price reductions, summarized to annual means and the newest month",
            f"through {newest}", len(metrics),
            {
                "attribution": ATTRIBUTION,
                "source_file": filename,
                "source_sha256": hashlib.sha256(content).hexdigest(),
                "source_size_kb": round(len(content) / 1024, 1),
                "source_rows": int(len(history)),
                "source_newest_month": newest,
                "full_years": years,
                "quality_flagged_rows": int(history["flagged"].sum()),
                "metrics": {
                    "median_listing_price": "median_listing_price as published",
                    "active_listings": "active_listing_count as published",
                    "days_on_market": "median_days_on_market as published",
                    "price_reduced_share": "price_reduced_count over total_listing_count, "
                                           "null when the denominator is 0 or missing",
                },
                "aggregation": "annual rows are means of the months in each full calendar year, "
                               "monthly rows are the newest month with a value per metro and metric, "
                               "flagged months are kept",
            },
        )])
    print(f"[realtor] {history['cbsa_code'].nunique()} metros, {len(history)} monthly rows through "
          f"{newest}, {len(years)} full years, {len(metrics)} metric rows -> {OUT_FILE.name}")
    return OUT_FILE

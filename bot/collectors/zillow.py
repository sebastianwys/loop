from bot.common import RAW_DIR, fetch, looks_like_csv, manifest_entry, staged_folder

OUT_DIR = RAW_DIR / "zillow"
BASE = "https://files.zillowstatic.com/research/public_csvs"

# metro level, monthly. zhvi is the mid tier home value index, zori is rent
FILES = {
    "zhvi_metro.csv": (
        f"{BASE}/zhvi/Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
        "ZHVI, all homes, mid tier, smoothed, seasonally adjusted, monthly, metro",
    ),
    "zori_metro.csv": (
        f"{BASE}/zori/Metro_zori_uc_sfrcondomfr_sm_month.csv",
        "ZORI, all homes plus multifamily, smoothed, monthly, metro",
    ),
}

ATTRIBUTION = "Data provided by Zillow Research (zillow.com/research/data). Zillow terms of use apply."


# these csvs are gitignored, so the archived copy is the only copy. zillow can
# answer 200 with an error page, so fetch and prove every body first and write
# only once all of them are good. a partial run leaves the archive alone
def collect():
    downloads = []
    for filename, (url, dataset) in FILES.items():
        print(f"[zillow] fetching {filename}")
        response = fetch(url)
        response.raise_for_status()
        if not response.content.strip():
            raise RuntimeError(f"{filename} came back empty")
        if not looks_like_csv(response.content):
            raise RuntimeError(f"{filename} came back without a RegionName header, usually an error page")
        downloads.append((filename, url, dataset, response.content))

    # both files and their manifest land together, so a second file that fails
    # cannot leave the first one replaced under the previous manifest
    with staged_folder(OUT_DIR) as landing:
        entries = []
        for filename, url, dataset, content in downloads:
            path = landing.bytes(filename, content)

            # last column header is the newest month, which is the file's version
            header = content.split(b"\n", 1)[0].decode()
            newest_month = header.rsplit(",", 1)[-1].strip()
            row_count = content.count(b"\n") - 1

            entries.append(manifest_entry(path, url, "Zillow Research", dataset,
                                          f"through {newest_month}", row_count, ATTRIBUTION))
            print(f"[zillow] {row_count} rows through {newest_month} -> {filename}")

        landing.manifest(entries)
    return OUT_DIR

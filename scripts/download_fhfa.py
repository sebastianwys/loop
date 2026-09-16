import requests
import hashlib
import json
import pandas as pd
from pathlib import Path
from datetime import datetime, timezone

BASE_DIR = Path(__file__).parent.parent
RAW_DIR = BASE_DIR / "data" / "raw" / "fhfa"
RAW_DIR.mkdir(parents=True, exist_ok=True)

# the two files we pull
FILES = {
    "hpi_master.csv": "https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv",
    "hpi_exp_metro.txt": "https://www.fhfa.gov/hpi/download/quarterly_datasets/hpi_exp_metro.txt",
}


# hash big files in chunks so memory stays flat
def compute_sha256(filepath):
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        while True:
            chunk = f.read(8192)
            if not chunk:
                break
            sha256.update(chunk)
    return sha256.hexdigest()


# row count. csv via pandas, txt by line count minus header
def _row_count(filepath, filename):
    if filename.endswith(".csv"):
        return len(pd.read_csv(filepath))
    with open(filepath) as f:
        return sum(1 for _ in f) - 1


# quarter tag like 2026-Q2, read from the newest observation in the file
def _version_tag(filepath, filename):
    try:
        if filename.endswith(".csv"):
            frame = pd.read_csv(filepath)
            # monthly rows carry a month, quarterly rows already carry a quarter
            quarter = frame["period"].where(
                frame["frequency"] == "quarterly",
                (frame["period"] - 1) // 3 + 1,
            )
        else:
            frame = pd.read_csv(filepath, sep="\t")
            quarter = frame["qtr"]
        year, quarter = max(zip(frame["yr"], quarter))
        return f"{int(year)}-Q{int(quarter)}"
    except Exception:
        # fall back to the download date when the file will not parse
        now = datetime.now(timezone.utc)
        return f"{now.year}-Q{(now.month - 1) // 3 + 1}"


# download one file, hash it, build the manifest entry
def download_file(filename, url):
    print(f"Downloading file {filename}...")
    response = requests.get(url)
    response.raise_for_status()  # fail fast if fhfa is down

    filepath = RAW_DIR / filename
    with open(filepath, "wb") as f:
        f.write(response.content)

    checksum = compute_sha256(filepath)
    size_kb = filepath.stat().st_size / 1024
    row_count = _row_count(filepath, filename)

    print(f"Saved to {filepath}")
    print(f"Size: {size_kb:.1f} KB | Rows: {row_count} | SHA-256: {checksum}")

    return {
        "filename": filename,
        "file_format": "CSV" if filename.endswith(".csv") else "TXT",
        "source": {
            "url": url,
            "provider": "Federal Housing Finance Agency (FHFA)",
            "access_method": "direct HTTP download"
        },
        "integrity": {
            "sha256": checksum,
            "size_kb": round(size_kb, 1),
            "row_count": row_count
        },
        "version": _version_tag(filepath, filename),
        "downloaded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    }


# pull both files, write manifest
def main():
    manifest = []
    for filename, url in FILES.items():
        info = download_file(filename, url)
        manifest.append(info)

    manifest_path = RAW_DIR / "download_manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\nManifest saved to {manifest_path}")
    print("FHFA download complete.")


if __name__ == "__main__":
    main()

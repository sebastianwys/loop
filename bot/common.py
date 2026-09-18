import contextlib
import hashlib
import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

BASE_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = BASE_DIR / "data" / "raw"
INTEGRATED = BASE_DIR / "data" / "integrated" / "hpi_census_merged.csv"
WEB_DATA_DIR = BASE_DIR / "web" / "public" / "data"

# identify the bot to every source. polite, and it makes us easy to contact
USER_AGENT = "loop-bot/0.1 (+https://github.com/sebastianwys/loop)"

# the study years, same as the census vintages
STUDY_YEARS = [2014, 2019, 2024]


# every collector fetches through here so the timeout, retry and user agent
# policy live in one place. retries on connection errors and 5xx only
def fetch(url, params=None, json_body=None, timeout=120, retries=3):
    headers = {"User-Agent": USER_AGENT}
    last_error = None
    for attempt in range(retries):
        try:
            if json_body is not None:
                response = requests.post(url, json=json_body, timeout=timeout, headers=headers)
            else:
                response = requests.get(url, params=params, timeout=timeout, headers=headers)
            if response.status_code < 500:
                return response
            last_error = RuntimeError(f"HTTP {response.status_code}")
        except requests.RequestException as e:
            last_error = e
        time.sleep(2 ** attempt)
    # with retries below one the loop never runs and there is no error to
    # re-raise, so this used to raise None and fail about its own bookkeeping
    if last_error is None:
        raise RuntimeError(f"{url}: no attempt was made, retries={retries}")
    raise last_error


# a zillow research csv always names RegionName in its header. a 200 carrying
# an error page does not, which is the only thing that separates them
def looks_like_csv(content):
    header = content.split(b"\n", 1)[0].decode("utf-8", "replace")
    return "RegionName" in [field.strip().strip('"') for field in header.split(",")]


def env_key(var):
    return os.environ.get(var, "").strip()


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# same chunked hash as the pipeline scripts
def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            digest.update(chunk)
    return digest.hexdigest()


# same manifest shape as data/raw/fhfa and data/raw/census
def manifest_entry(path, endpoint, provider, dataset, version, row_count, notes=None):
    entry = {
        "filename": path.name,
        "file_format": path.suffix.lstrip(".").upper(),
        "source": {
            "endpoint": endpoint,
            "provider": provider,
            "access_method": "REST API" if "api." in endpoint else "Direct HTTP download",
            "dataset": dataset,
        },
        "integrity": {
            "sha256": sha256_file(path),
            "size_kb": round(path.stat().st_size / 1024, 1),
            "row_count": row_count,
        },
        "version": version,
        "downloaded_at": utc_now(),
    }
    if notes:
        entry["notes"] = notes
    return entry


# the file every collector writes beside its downloads
MANIFEST_FILE = "download_manifest.json"

# the fields that move on every run whether or not the data did
STAMP_KEYS = ("downloaded_at", "generated_at")


def _restamp(node, other, keys):
    if isinstance(node, dict) and isinstance(other, dict):
        return {k: other[k] if k in keys and k in other else _restamp(v, other.get(k), keys)
                for k, v in node.items()}
    if isinstance(node, list) and isinstance(other, list) and len(node) == len(other):
        return [_restamp(a, b, keys) for a, b in zip(node, other)]
    return node


# a refresh that finds nothing new must leave the file alone. a timestamp is the
# one field that always moves, so a payload matching the one on disk apart from
# its stamps is not a change, and rewriting it would commit the whole file and
# republish the site for nothing
def unchanged_but_for_stamps(path, payload, keys=STAMP_KEYS):
    if not Path(path).exists():
        return False
    try:
        previous = json.loads(Path(path).read_text())
    except ValueError:
        return False
    return _restamp(payload, previous, keys) == previous


# every raw file under data/raw is the only copy the pipeline has of a vintage
# its publisher does not keep, so a write that dies partway has to cost the new
# file rather than the old one. the body lands beside its destination and is
# renamed over it, which os.replace does atomically inside one filesystem, and a
# name beside the destination always is one. a run killed mid-write then leaves
# the previous archive whole, and nothing half written for the next run to read
def replace_atomically(path, write):
    path = Path(path)
    staged = path.with_name(path.name + ".part")
    try:
        write(staged)
        os.replace(staged, path)
    except BaseException:
        staged.unlink(missing_ok=True)
        raise
    return path


# the common case, a collector's table. index=False everywhere, since every
# archive under data/raw is a plain table
def write_csv(frame, path, **kwargs):
    return replace_atomically(path, lambda staged: frame.to_csv(staged, index=False, **kwargs))


def write_manifest(folder, entries):
    path = folder / MANIFEST_FILE
    if unchanged_but_for_stamps(path, entries):
        return path
    return replace_atomically(path, lambda staged: staged.write_text(json.dumps(entries, indent=2) + "\n"))


# one file at a time is not enough for a collector that writes several. a run
# that dies between two of them leaves a folder holding some of this run's files
# and some of the last one's, under a manifest describing neither, which is the
# half-replaced folder the scripts/ download guard was given a staging directory
# to prevent.
#
# every file is written under a staging directory inside the folder and keeps
# the name it will land under, so manifest_entry hashes and names the file this
# run produced rather than the one still on disk. nothing is renamed over the
# archive until the body reaches the end, and a body that raises takes the
# staging directory with it and leaves the previous vintage entire
class Landing:
    def __init__(self, folder, staging):
        self.folder, self.staging, self.names = folder, staging, []

    # where to write a file: the name it will land under, inside staging
    def path(self, name):
        name = Path(name).name
        if name not in self.names:
            self.names.append(name)
        return self.staging / name

    # a frame, through the same index=False rule write_csv uses
    def csv(self, frame, name, **kwargs):
        path = self.path(name)
        frame.to_csv(path, index=False, **kwargs)
        return path

    def text(self, name, text):
        path = self.path(name)
        path.write_text(text)
        return path

    def bytes(self, name, content):
        path = self.path(name)
        path.write_bytes(content)
        return path

    # the manifest lands with the files it describes. a refresh that finds
    # nothing new still leaves it alone, the same rule write_manifest applies
    def manifest(self, entries):
        path = self.folder / MANIFEST_FILE
        if unchanged_but_for_stamps(path, entries):
            return path
        self.text(MANIFEST_FILE, json.dumps(entries, indent=2) + "\n")
        return path

    def commit(self):
        for name in self.names:
            os.replace(self.staging / name, self.folder / name)


@contextlib.contextmanager
def staged_folder(folder):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=folder, prefix=".staging-") as staging:
        landing = Landing(folder, Path(staging))
        yield landing
        landing.commit()

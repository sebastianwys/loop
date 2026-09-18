# the integrated file every later step is pinned to, read through one door.
# the point is that a model can never train on a frame nobody can reproduce:
# the hash is checked on every read, the code columns come back as the strings
# every join downstream expects, and the two columns carrying one value for the
# whole file are dropped rather than travelling as noise.
#
# when the pipeline is re-run on purpose, SHA256 moves here in the same commit
# as the prose in ml/README.md that quotes it

import hashlib
from pathlib import Path

import pandas as pd

from loop import spec

PATH = spec.REPO_ROOT / "data" / "integrated" / "hpi_census_merged.csv"
SHA256 = "b65d953f4c6beed7266be7da74292c45917d4c2fa404ba6414c402610dc18deb"

# the shape the published file has, checked so a file that hashes differently
# on purpose still cannot be a different dataset by accident
ROWS = 1204
METROS = 410
YEARS = [2014, 2019, 2024]

# codes, not numbers. read as anything else, a blank parent_cbsa becomes
# 16980.0 and a cbsa_code stops matching the strings it is joined on
CODES = ["place_id", "cbsa_code", "geo_code", "parent_cbsa", "metropolitan division"]

# free text, never arithmetic
TEXT = ["place_name", "NAME", "geo_level"]

# one value for every row of the published file, so they say nothing per row
CONSTANT = {"hpi_type": "traditional", "hpi_flavor": "all-transactions"}


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


# a blank code column reads as nan through dtype=str, and nan is not a code
def _codes(frame):
    for column in CODES:
        if column in frame.columns:
            frame[column] = frame[column].fillna("").astype(str).str.strip()
    return frame


def _drop_constant(frame, path):
    for column, only in CONSTANT.items():
        if column not in frame.columns:
            continue
        values = set(frame[column].dropna().unique())
        if values - {only}:
            raise ValueError(f"{path.name}: {column} is not constant, it carries {sorted(values)}")
    return frame.drop(columns=[c for c in CONSTANT if c in frame.columns])


# sha256 None reads whatever is on disk, which is how a test builds a frame that
# was never published. every other caller gets the published file or an error
def load(path=None, sha256=SHA256):
    path = Path(PATH if path is None else path)
    if not path.exists():
        raise FileNotFoundError(f"{path} is missing, run the pipeline first")
    if sha256 is not None:
        found = sha256_of(path)
        if found != sha256:
            raise ValueError(
                f"{path.name} is not the published file: sha256 {found[:12]} where {sha256[:12]} was expected. "
                "re-run the pipeline on purpose and move SHA256 in loop.data in the same commit"
            )

    frame = pd.read_csv(path, dtype={column: str for column in CODES})
    frame = _drop_constant(_codes(frame), path)
    frame["year"] = frame["year"].astype(int)
    for column in frame.columns:
        if column not in CODES and column not in TEXT and column != "year":
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
    return frame


# the shape assertion, separate so a caller can read the file without it and a
# test can say which half failed
def check_shape(frame):
    if len(frame) != ROWS:
        raise ValueError(f"the integrated file holds {len(frame)} rows, not {ROWS}")
    metros = frame["cbsa_code"].nunique()
    if metros != METROS:
        raise ValueError(f"the integrated file holds {metros} metros, not {METROS}")
    years = sorted(int(y) for y in frame["year"].unique())
    if years != YEARS:
        raise ValueError(f"the integrated file holds years {years}, not {YEARS}")
    return frame

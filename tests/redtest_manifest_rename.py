# a red test. run from the project root:
#   ml/.venv/bin/python -m unittest tests/redtest_manifest_rename.py -v
#
# both scripts/ collectors stage every file, rename the data over the archive,
# and only then open download_manifest.json for writing, which truncates it in
# place. a manifest write that dies there (a full disk, a stopped container)
# leaves the new files under a manifest that no longer parses. the write is made
# to die the way the audit probe did it: json.dump writes half its text and
# raises enospc. every folder here is temporary and the network is a stub

import contextlib
import errno
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pandas as pd

# scripts/ is not a package, so put it on the path before importing
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import download_census as dc
import download_fhfa as dfhfa

MANIFEST = "download_manifest.json"

MASTER_HEADER = (
    "hpi_type,hpi_flavor,frequency,level,place_name,place_id,yr,period,"
    "index_nsa,index_sa,rstderr,note\n"
)
METRO_HEADER = "city\tmetro_name\tyr\tqtr\tindex_nsa\n"

# the archive as the last good run left it, and the newer bodies fhfa answers
FHFA_BEFORE = {
    "hpi_master.csv": MASTER_HEADER
    + "traditional,purchase-only,quarterly,MSA,\"Abilene, TX\",10180,2026,2,264.64,265.92,,\n",
    "hpi_exp_metro.txt": METRO_HEADER + "Abilene\tAbilene TX\t2026\t2\t264.64\n",
}
FHFA_AFTER = {
    "hpi_master.csv": MASTER_HEADER
    + "traditional,purchase-only,quarterly,MSA,\"Abilene, TX\",10180,2026,3,266.00,267.00,,\n",
    "hpi_exp_metro.txt": METRO_HEADER + "Abilene\tAbilene TX\t2026\t3\t266.00\n",
}

YEARS = [2024, 2019, 2014]


def sha256_of(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


# the part of a manifest entry this test reads: the file and its hash
def manifest_for(folder, names):
    entries = [{"filename": name, "integrity": {"sha256": sha256_of(folder / name)}} for name in names]
    (folder / MANIFEST).write_text(json.dumps(entries, indent=2))


# a disk that fills while the manifest is being written
def dies_halfway(obj, fp, *args, **kwargs):
    text = json.dumps(obj, *args, **kwargs)
    fp.write(text[: len(text) // 2])
    fp.flush()
    raise OSError(errno.ENOSPC, "No space left on device")


class FhfaSite:
    def get(self, url):
        response = mock.Mock()
        response.content = FHFA_AFTER[url.rsplit("/", 1)[1]].encode()
        response.raise_for_status.return_value = None
        return response


def acs_frame(year, income):
    return pd.DataFrame([{
        "NAME": "Abilene, TX Metro Area", "B19013_001E": income, "B01003_001E": "170000",
        "B01002_001E": "34.5", "B15003_001E": "100000", "B15003_022E": "20000",
        "B15003_023E": "6000", "B25003_001E": "63000", "B25003_002E": "40000",
        "B25077_001E": "150000", dc.MSA_COL: "10180", dc.DIV_COL: "",
        "geo_level": "msa", "geo_code": "10180", "parent_cbsa": "", "year": year,
    }])


class ManifestCase(unittest.TestCase):
    maxDiff = None

    def folder(self, name):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        folder = Path(tmp.name) / name
        folder.mkdir()
        return folder

    # the run has to have reached the write this test makes die, or a green
    # result would say nothing about it
    def assert_died_writing_the_manifest(self, outcome):
        self.assertIsInstance(outcome, OSError, "the manifest write this test makes die was never reached")
        self.assertEqual(outcome.errno, errno.ENOSPC)

    # the invariant: whatever the run left, the manifest parses and names the
    # hash of every file it lists as that file sits in the folder. the previous
    # files under the previous manifest pass, the new files under a whole new
    # manifest pass, anything in between does not
    def assert_manifest_describes_folder(self, folder, replaced):
        text = (folder / MANIFEST).read_text()
        try:
            entries = json.loads(text)
        except ValueError as error:
            self.fail(f"{MANIFEST} no longer parses ({error}), {len(text)} bytes on disk, "
                      f"beside data files already replaced: {replaced}")
        recorded = {entry["filename"]: entry["integrity"]["sha256"] for entry in entries}
        self.assertEqual(recorded, {name: sha256_of(folder / name) for name in recorded})


class TestFhfaManifestIsRenamedOverNeverTruncated(ManifestCase):
    def archive(self):
        folder = self.folder("fhfa")
        for name, body in FHFA_BEFORE.items():
            (folder / name).write_text(body)
        manifest_for(folder, FHFA_BEFORE)
        return folder

    def run_main(self, folder, dump=json.dump):
        with mock.patch.object(dfhfa, "RAW_DIR", folder), \
             mock.patch.object(dfhfa, "requests", FhfaSite()), \
             mock.patch.object(json, "dump", dump), \
             contextlib.redirect_stdout(io.StringIO()):
            try:
                dfhfa.main()
            except Exception as error:
                return error
        return None

    def replaced(self, folder):
        return sorted(name for name, body in FHFA_BEFORE.items() if (folder / name).read_text() != body)

    def test_a_manifest_write_that_dies_leaves_a_manifest_describing_the_folder(self):
        folder = self.archive()
        outcome = self.run_main(folder, dump=dies_halfway)
        self.assert_died_writing_the_manifest(outcome)
        self.assert_manifest_describes_folder(folder, self.replaced(folder))

    # the control, green today: a run that finishes publishes the new files
    # under a manifest naming them
    def test_a_run_that_finishes_publishes_the_files_and_their_manifest(self):
        folder = self.archive()
        self.assertIsNone(self.run_main(folder))
        self.assertEqual(self.replaced(folder), sorted(FHFA_AFTER))
        self.assert_manifest_describes_folder(folder, self.replaced(folder))


class TestCensusManifestIsRenamedOverNeverTruncated(ManifestCase):
    def archive(self):
        folder = self.folder("census")
        names = []
        for year in sorted(YEARS):
            name = f"acs_5yr_{year}.csv"
            acs_frame(year, "60000").to_csv(folder / name, index=False)
            names.append(name)
        pd.concat([acs_frame(y, "60000") for y in sorted(YEARS)]).to_csv(folder / "acs_5yr_combined.csv", index=False)
        manifest_for(folder, names)
        (folder / "vintages.json").write_text(json.dumps({"years": YEARS}))
        self.before = {p.name: p.read_bytes() for p in folder.iterdir() if p.suffix == ".csv"}
        return folder

    # resolve_years reads the pin copied into the folder, the api is a stub
    def run_main(self, folder, dump=json.dump):
        with mock.patch.object(dc, "RAW_DIR", folder), \
             mock.patch.object(dc, "VINTAGES_FILE", folder / "vintages.json"), \
             mock.patch.object(dc, "load_api_key", return_value="synthetic-key"), \
             mock.patch.object(dc, "fetch_acs_data", side_effect=lambda year, key: acs_frame(year, "61000")), \
             mock.patch.object(sys, "argv", ["download_census.py"]), \
             mock.patch.object(json, "dump", dump), \
             contextlib.redirect_stdout(io.StringIO()):
            try:
                dc.main()
            except (Exception, SystemExit) as error:
                return error
        return None

    def replaced(self, folder):
        return sorted(name for name, body in self.before.items() if (folder / name).read_bytes() != body)

    def test_a_manifest_write_that_dies_leaves_a_manifest_describing_the_folder(self):
        folder = self.archive()
        outcome = self.run_main(folder, dump=dies_halfway)
        self.assert_died_writing_the_manifest(outcome)
        self.assert_manifest_describes_folder(folder, self.replaced(folder))

    def test_a_run_that_finishes_publishes_the_files_and_their_manifest(self):
        folder = self.archive()
        self.assertIsNone(self.run_main(folder))
        self.assertEqual(self.replaced(folder), sorted(self.before))
        self.assert_manifest_describes_folder(folder, self.replaced(folder))


if __name__ == "__main__":
    unittest.main()

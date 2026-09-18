# run: ml/.venv/bin/python -m unittest tests.redtest_partial_replace -v

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pandas as pd
import requests

# scripts/ is not a package, so put it on the path before importing
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import download_census as dc
import download_fhfa as dfhfa

# built at runtime, never written down
ARCHIVE = Path(__file__).resolve().parent.parent / "data" / "raw"


def sha256_of(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


# rows under the header. csv through pandas so quoted fields are honoured
def row_count_of(path):
    if path.suffix == ".csv":
        return len(pd.read_csv(path, dtype=str))
    with open(path) as handle:
        return sum(1 for _ in handle) - 1


# the integrity record the manifest publishes, keyed by file. build_map_data
# copies this onto the public sources page
def published_integrity(raw_dir):
    entries = json.loads((raw_dir / "download_manifest.json").read_text())
    return {
        entry["filename"]: {
            "row_count": entry["integrity"]["row_count"],
            "sha256": entry["integrity"]["sha256"],
        }
        for entry in entries
    }


# the same record, measured off the files actually sitting in the folder
def measured_integrity(raw_dir, filenames):
    return {
        name: {
            "row_count": row_count_of(raw_dir / name),
            "sha256": sha256_of(raw_dir / name),
        }
        for name in filenames
    }


class StubResponse:
    def __init__(self, status_code, content, content_type="application/json", error=None):
        self.status_code = status_code
        self.content = content
        self.headers = {"content-type": content_type}
        self.error = error

    def raise_for_status(self):
        if self.error:
            raise self.error

    def json(self):
        return json.loads(self.content.decode())


# one msa row, or one division row, shaped the way the api answers. row 0 is
# the column names and every value comes back as a string
ACS_VALUES = ["60000", "170000", "34.5", "100000", "20000", "6000", "63000", "40000", "150000"]


def acs_payload(params):
    if params["for"].startswith(dc.DIV_COL):
        parent = params["in"].split(":")[1]
        header = dc.VARIABLES + [dc.MSA_COL, dc.DIV_COL]
        row = ["Division of " + parent] + ACS_VALUES + [parent, "9" + parent[1:]]
        return [header, row]
    header = dc.VARIABLES + [dc.MSA_COL]
    return [header, ["Abilene, TX Metro Area"] + ACS_VALUES + ["10180"]]


# stands in for the requests module inside download_census, so nothing leaves
# the machine and no api key is needed
class CensusApiStub:
    HTTPError = requests.HTTPError

    def __init__(self, server_error=(), no_observations=(), empty_status=204):
        self.server_error = set(server_error)
        self.no_observations = set(no_observations)
        self.empty_status = empty_status

    def get(self, url, params=None, timeout=None):
        year = int(url.split("/data/")[1].split("/")[0])
        if year in self.server_error:
            return StubResponse(500, b"", "text/html", requests.HTTPError(
                "500 Server Error: Internal Server Error for url: " + url
            ))
        # 204, or 200 with an empty body, the two cases query_acs documents
        if year in self.no_observations:
            return StubResponse(self.empty_status, b"")
        return StubResponse(200, json.dumps(acs_payload(params)).encode())


# the same stand-in for download_fhfa, keyed by the file at the end of the url
class FhfaSiteStub:
    def __init__(self, bodies):
        self.bodies = bodies

    def get(self, url):
        return StubResponse(200, self.bodies[url.rsplit("/", 1)[1]].encode())


# a valid slice of hpi_master.csv, newer than the archived copy
MASTER_SLICE = (
    "hpi_type,hpi_flavor,frequency,level,place_name,place_id,yr,period,"
    "index_nsa,index_sa,rstderr,note\n"
    "traditional,purchase-only,monthly,USA or Census Division,"
    "East North Central Division,DV_ENC,1991,1,100.00,100.00,,\n"
    "traditional,purchase-only,quarterly,MSA,\"Abilene, TX\",10180,"
    "2026,3,266.00,267.00,,\n"
)

# what fhfa serves when the site is down. status 200, body html
MAINTENANCE_PAGE = (
    "<!DOCTYPE html><html><head><title>Site maintenance</title></head>"
    "<body><h1>We will be back shortly</h1></body></html>"
)


# resolve_years reads the copied vintages.json, so the pinned years come off
# the archive copy rather than out of a stub
def run_census_main(raw_dir, api):
    with mock.patch.object(dc, "RAW_DIR", raw_dir), \
         mock.patch.object(dc, "VINTAGES_FILE", raw_dir / "vintages.json"), \
         mock.patch.object(dc, "load_api_key", return_value="stub-key"), \
         mock.patch.object(dc, "requests", api):
        try:
            dc.main()
        except SystemExit as exit_error:
            return exit_error
    return None


def run_fhfa_main(raw_dir, bodies):
    with mock.patch.object(dfhfa, "RAW_DIR", raw_dir), \
         mock.patch.object(dfhfa, "requests", FhfaSiteStub(bodies)):
        try:
            dfhfa.main()
        except Exception as error:
            return error
    return None


class ArchiveCopyCase(unittest.TestCase):
    # show the whole record when it does not match, it is the evidence
    maxDiff = None

    # the raw archive is the vintage, so every run here works on a throwaway
    # copy. no download function may write under the repo data folder
    def archive_copy(self, source):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        raw_dir = Path(tmp.name) / source
        shutil.copytree(ARCHIVE / source, raw_dir)
        self.assertNotIn(ARCHIVE, raw_dir.parents)
        return raw_dir

    # the invariant: the manifest names the sha256 and the row count of the
    # file lying beside it, whether the run finished or gave up
    def assert_manifest_describes_disk(self, raw_dir):
        published = published_integrity(raw_dir)
        self.assertEqual(published, measured_integrity(raw_dir, sorted(published)))


class TestCensusManifestDescribesTheFilesOnDisk(ArchiveCopyCase):
    # 2014 and 2019 are written before 2024 is requested at all, so a failure
    # on the newest vintage has to leave the older files as the manifest has
    # them, or be rolled back to them
    def test_a_failed_vintage_leaves_the_earlier_years_as_published(self):
        raw_dir = self.archive_copy("census")
        self.assert_manifest_describes_disk(raw_dir)

        exit_error = run_census_main(raw_dir, CensusApiStub(server_error={2024}))

        self.assertIsNotNone(exit_error, "a missing vintage was reported as success")
        self.assert_manifest_describes_disk(raw_dir)


class TestFhfaManifestDescribesTheFilesOnDisk(ArchiveCopyCase):
    # hpi_master.csv is replaced before hpi_exp_metro.txt is requested at all
    def test_a_failed_second_file_leaves_the_first_as_published(self):
        raw_dir = self.archive_copy("fhfa")
        self.assert_manifest_describes_disk(raw_dir)

        error = run_fhfa_main(raw_dir, {
            "hpi_master.csv": MASTER_SLICE,
            "hpi_exp_metro.txt": MAINTENANCE_PAGE,
        })

        self.assertIsInstance(error, RuntimeError)
        self.assert_manifest_describes_disk(raw_dir)


class TestCensusRefusesAVintageWithNoObservations(ArchiveCopyCase):
    # fhfa _validate refuses a header with no observations under it. the census
    # path needs the same floor: an empty msa answer is an outage, not a vintage
    def check_the_vintage_survives(self, empty_status):
        raw_dir = self.archive_copy("census")
        name = "acs_5yr_2024.csv"
        before = {name: row_count_of(raw_dir / name)}

        exit_error = run_census_main(
            raw_dir, CensusApiStub(no_observations={2024}, empty_status=empty_status)
        )

        self.assertEqual(before, {name: row_count_of(raw_dir / name)})
        self.assertIsNotNone(exit_error, "an empty vintage was reported as success")

    def test_a_vintage_answering_204_does_not_become_a_header_only_file(self):
        self.check_the_vintage_survives(204)

    def test_a_vintage_answering_200_with_an_empty_body_does_not_either(self):
        self.check_the_vintage_survives(200)


class TestFhfaBodyGuardsSayWhatTheyRejected(unittest.TestCase):
    # these two pass today. they pin the message, not merely that something
    # raised: delete the size guard and an empty body raises pandas
    # EmptyDataError, delete the html guard and the same page comes back as
    # the missing columns error instead
    def reject(self, payload):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        raw_dir = Path(tmp.name)
        (raw_dir / "hpi_master.csv").write_text(MASTER_SLICE)
        with mock.patch.object(dfhfa, "RAW_DIR", raw_dir), \
             mock.patch.object(dfhfa, "requests", FhfaSiteStub({"hpi_master.csv": payload})):
            with self.assertRaises(Exception) as caught:
                dfhfa.download_file("hpi_master.csv", dfhfa.FILES["hpi_master.csv"])
        return caught.exception

    def test_an_empty_body_is_rejected_as_empty(self):
        error = self.reject("")
        self.assertEqual(str(error), "hpi_master.csv came back empty")
        self.assertNotIsInstance(error, ValueError)

    def test_an_html_body_is_rejected_as_html(self):
        error = self.reject(MAINTENANCE_PAGE)
        self.assertEqual(
            str(error),
            "hpi_master.csv came back as html, usually an fhfa maintenance page",
        )
        self.assertNotIsInstance(error, ValueError)


if __name__ == "__main__":
    unittest.main()

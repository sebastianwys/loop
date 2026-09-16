import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pandas as pd

# scripts/ is not a package, so put it on the path before importing
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import download_census as dc
import download_fhfa as dfhfa


# a valid slice of hpi_master.csv, enough rows and columns to pass validation
MASTER_SLICE = (
    "hpi_type,hpi_flavor,frequency,level,place_name,place_id,yr,period,"
    "index_nsa,index_sa,rstderr,note\n"
    "traditional,purchase-only,monthly,USA or Census Division,"
    "East North Central Division,DV_ENC,1991,1,100.00,100.00,,\n"
    "traditional,purchase-only,quarterly,MSA,\"Abilene, TX\",10180,"
    "2026,2,264.64,265.92,,\n"
)

# what fhfa serves when the site is down. status 200, body html
MAINTENANCE_PAGE = (
    "<!DOCTYPE html><html><head><title>Site maintenance</title></head>"
    "<body><h1>We will be back shortly</h1></body></html>"
)


def _response(payload, content_type="text/csv"):
    response = mock.Mock()
    response.content = payload.encode() if isinstance(payload, str) else payload
    response.headers = {"content-type": content_type}
    response.raise_for_status.return_value = None
    return response


# hpi_master.csv has no vintage parameter, so the archived file IS the vintage.
# a body written over it before anyone checks what it is cannot be recovered
class TestFhfaArchiveSurvivesABadBody(unittest.TestCase):
    def run_download(self, payload, content_type="text/csv"):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        raw = Path(tmp.name)
        archive = raw / "hpi_master.csv"
        archive.write_text(MASTER_SLICE)
        before = archive.read_bytes()
        with mock.patch.object(dfhfa, "RAW_DIR", raw), \
             mock.patch.object(dfhfa, "requests") as requests_stub:
            requests_stub.get.return_value = _response(payload, content_type)
            try:
                entry = dfhfa.download_file(
                    "hpi_master.csv", dfhfa.FILES["hpi_master.csv"]
                )
            except Exception as error:
                return archive, before, error
            return archive, before, entry

    def test_html_maintenance_page_does_not_touch_the_archive(self):
        archive, before, outcome = self.run_download(
            MAINTENANCE_PAGE, "text/html; charset=utf-8"
        )
        self.assertIsInstance(outcome, Exception)
        self.assertEqual(archive.read_bytes(), before)

    # an html body served with a csv content type is the same loss
    def test_html_body_mislabelled_as_csv_does_not_touch_the_archive(self):
        archive, before, outcome = self.run_download(MAINTENANCE_PAGE, "text/csv")
        self.assertIsInstance(outcome, Exception)
        self.assertEqual(archive.read_bytes(), before)

    def test_empty_body_does_not_touch_the_archive(self):
        archive, before, outcome = self.run_download("")
        self.assertIsInstance(outcome, Exception)
        self.assertEqual(archive.read_bytes(), before)

    # a header row with no observations under it is not a vintage either
    def test_header_only_body_does_not_touch_the_archive(self):
        header = MASTER_SLICE.splitlines()[0] + "\n"
        archive, before, outcome = self.run_download(header)
        self.assertIsInstance(outcome, Exception)
        self.assertEqual(archive.read_bytes(), before)

    # a parsable csv that is not this dataset, say a redirect landing page
    def test_wrong_columns_do_not_touch_the_archive(self):
        archive, before, outcome = self.run_download("a,b\n1,2\n")
        self.assertIsInstance(outcome, Exception)
        self.assertEqual(archive.read_bytes(), before)

    # the guard must not block a real download
    def test_good_payload_replaces_the_archive_and_reports_it(self):
        archive, before, outcome = self.run_download(MASTER_SLICE.replace("100.00", "101.00"))
        self.assertIsInstance(outcome, dict)
        self.assertNotEqual(archive.read_bytes(), before)
        self.assertEqual(outcome["integrity"]["row_count"], 2)

    # no half written .part file is left behind for the next run to trip on
    def test_rejected_body_leaves_no_scratch_file(self):
        archive, _, _ = self.run_download(MAINTENANCE_PAGE)
        siblings = sorted(p.name for p in archive.parent.iterdir())
        self.assertEqual(siblings, ["hpi_master.csv"])


ACS_ROW = {
    "NAME": "Abilene, TX Metro Area",
    "B19013_001E": "60000",
    "B01003_001E": "170000",
    "B01002_001E": "34.5",
    "B15003_022E": "20000",
    "B15003_023E": "6000",
    "B25003_001E": "63000",
    "B25003_002E": "40000",
    "B25077_001E": "150000",
    dc.MSA_COL: "10180",
    dc.DIV_COL: "",
    "geo_level": "msa",
    "geo_code": "10180",
    "parent_cbsa": "",
    "year": 2024,
}


def _acs_frame(year):
    row = dict(ACS_ROW, year=year)
    return pd.DataFrame([row])


class TestCensusKeepsThePreviousVintages(unittest.TestCase):
    def run_main(self, years, failing, existing=()):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        raw = Path(tmp.name)
        for name, text in existing:
            (raw / name).write_text(text)

        def fetch(year, api_key):
            if year in failing:
                raise RuntimeError("census answered html")
            return _acs_frame(year)

        with mock.patch.object(dc, "RAW_DIR", raw), \
             mock.patch.object(dc, "resolve_years", return_value=years), \
             mock.patch.object(dc, "load_api_key", return_value="key"), \
             mock.patch.object(dc, "fetch_acs_data", side_effect=fetch):
            try:
                dc.main()
            except SystemExit as exit_error:
                return raw, exit_error
        return raw, None

    # every vintage failing must not leave the archive emptier than it started
    def test_a_failed_run_keeps_the_stale_per_year_file(self):
        raw, exit_error = self.run_main(
            [2024, 2019, 2014],
            failing={2024, 2019, 2014},
            existing=[("acs_5yr_2011.csv", "NAME,year\nold,2011\n")],
        )
        self.assertIsNotNone(exit_error)
        self.assertTrue((raw / "acs_5yr_2011.csv").exists())

    # a partial pull must not be published over the complete one
    def test_a_failed_vintage_does_not_overwrite_the_combined_csv(self):
        previous = "NAME,year\ncomplete,2024\n"
        raw, exit_error = self.run_main(
            [2024, 2019, 2014],
            failing={2014},
            existing=[("acs_5yr_combined.csv", previous)],
        )
        self.assertIsNotNone(exit_error)
        self.assertEqual((raw / "acs_5yr_combined.csv").read_text(), previous)

    # nor over the manifest that describes it
    def test_a_failed_vintage_does_not_overwrite_the_manifest(self):
        previous = '[{"filename": "acs_5yr_combined.csv"}]'
        raw, exit_error = self.run_main(
            [2024, 2019, 2014],
            failing={2014},
            existing=[("download_manifest.json", previous)],
        )
        self.assertIsNotNone(exit_error)
        self.assertEqual((raw / "download_manifest.json").read_text(), previous)

    # a clean run still publishes and still drops the unpinned year
    def test_a_clean_run_publishes_and_removes_the_stale_file(self):
        raw, exit_error = self.run_main(
            [2024, 2019, 2014],
            failing=set(),
            existing=[("acs_5yr_2011.csv", "NAME,year\nold,2011\n")],
        )
        self.assertIsNone(exit_error)
        self.assertFalse((raw / "acs_5yr_2011.csv").exists())
        combined = pd.read_csv(raw / "acs_5yr_combined.csv")
        self.assertEqual(sorted(combined["year"].tolist()), [2014, 2019, 2024])
        self.assertTrue((raw / "download_manifest.json").exists())


if __name__ == "__main__":
    unittest.main()

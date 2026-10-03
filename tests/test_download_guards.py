import contextlib
import errno
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pandas as pd

REPO = Path(__file__).resolve().parent.parent

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


# hpi_master.csv has no vintage parameter, so the archived file is the vintage.
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

    # each guard is pinned by the message it rejects with, not merely by
    # something being raised: an incidental pandas parse error would say
    # something else, so deleting a guard cannot leave this suite green
    def assert_rejected_with(self, outcome, message):
        self.assertIsInstance(outcome, RuntimeError)
        self.assertEqual(str(outcome), message)

    def test_html_maintenance_page_does_not_touch_the_archive(self):
        archive, before, outcome = self.run_download(
            MAINTENANCE_PAGE, "text/html; charset=utf-8"
        )
        self.assert_rejected_with(
            outcome, "hpi_master.csv came back as html, usually an fhfa maintenance page"
        )
        self.assertEqual(archive.read_bytes(), before)

    # an html body served with a csv content type is the same loss
    def test_html_body_mislabelled_as_csv_does_not_touch_the_archive(self):
        archive, before, outcome = self.run_download(MAINTENANCE_PAGE, "text/csv")
        self.assert_rejected_with(
            outcome, "hpi_master.csv came back as html, usually an fhfa maintenance page"
        )
        self.assertEqual(archive.read_bytes(), before)

    def test_empty_body_does_not_touch_the_archive(self):
        archive, before, outcome = self.run_download("")
        self.assert_rejected_with(outcome, "hpi_master.csv came back empty")
        self.assertEqual(archive.read_bytes(), before)

    # a header row with no observations under it is not a vintage either
    def test_header_only_body_does_not_touch_the_archive(self):
        header = MASTER_SLICE.splitlines()[0] + "\n"
        archive, before, outcome = self.run_download(header)
        self.assert_rejected_with(
            outcome, "hpi_master.csv carries a header and no observations"
        )
        self.assertEqual(archive.read_bytes(), before)

    # a parsable csv that is not this dataset, say a redirect landing page
    def test_wrong_columns_do_not_touch_the_archive(self):
        archive, before, outcome = self.run_download("a,b\n1,2\n")
        self.assert_rejected_with(
            outcome,
            "hpi_master.csv is missing columns ['hpi_type', 'hpi_flavor', "
            "'frequency', 'level', 'place_id', 'yr', 'period', 'index_nsa']",
        )
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


METRO_SLICE = "city\tmetro_name\tyr\tqtr\tindex_nsa\nAbilene\tAbilene TX\t2026\t2\t264.64\n"


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


# fhfa answering both files with bodies newer than the archived ones
def _fhfa_site():
    site = mock.Mock()
    site.get.side_effect = lambda url: _response(
        (MASTER_SLICE if url.endswith(".csv") else METRO_SLICE).replace("264.64", "266.00"))
    return site


def _newer_acs_frame(year, api_key):
    return _acs_frame(year).assign(B19013_001E="61000")


# download_census.main on a temporary folder, with the key, the catalog and
# the api stubbed. hands back whatever the run raised
def _run_census(folder, argv=(), **patches):
    with mock.patch.object(dc, "RAW_DIR", folder), \
         mock.patch.object(dc, "VINTAGES_FILE", folder / "vintages.json"), \
         mock.patch.object(dc, "load_api_key", return_value="key"), \
         mock.patch.object(dc, "fetch_acs_data", side_effect=_newer_acs_frame), \
         mock.patch.object(sys, "argv", ["download_census.py", *argv]), \
         contextlib.ExitStack() as stack, \
         contextlib.redirect_stdout(io.StringIO()):
        for name, value in patches.items():
            stack.enter_context(mock.patch.object(dc, name, value))
        try:
            dc.main()
        except (Exception, SystemExit) as error:
            return error
    return None


# a disk that fills while the manifest is being written
def _dies_halfway(obj, fp, *args, **kwargs):
    text = json.dumps(obj, *args, **kwargs)
    fp.write(text[: len(text) // 2])
    raise OSError(errno.ENOSPC, "No space left on device")


# a manifest is renamed over with the files it describes, never truncated in
# place. a write that dies has to leave one that parses and still hashes to
# the files beside it
class TestAManifestWriteThatDiesLeavesAWholeManifest(unittest.TestCase):
    def folder(self, bodies):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        folder = Path(tmp.name)
        for name, body in bodies.items():
            (folder / name).write_text(body)
        entries = [{"filename": name, "integrity": {"sha256": _sha256(folder / name)}} for name in bodies]
        (folder / "download_manifest.json").write_text(json.dumps(entries))
        return folder

    def assert_manifest_describes_folder(self, folder):
        entries = json.loads((folder / "download_manifest.json").read_text())
        self.assertEqual({e["filename"]: e["integrity"]["sha256"] for e in entries},
                         {e["filename"]: _sha256(folder / e["filename"]) for e in entries})

    def test_download_fhfa(self):
        folder = self.folder({"hpi_master.csv": MASTER_SLICE, "hpi_exp_metro.txt": METRO_SLICE})
        with mock.patch.object(dfhfa, "RAW_DIR", folder), \
             mock.patch.object(dfhfa, "requests", _fhfa_site()), \
             mock.patch.object(json, "dump", _dies_halfway), \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(OSError):
                dfhfa.main()
        self.assert_manifest_describes_folder(folder)

    def test_download_census(self):
        folder = self.folder({f"acs_5yr_{y}.csv": _acs_frame(y).to_csv(index=False) for y in (2014, 2019, 2024)})
        (folder / "vintages.json").write_text(json.dumps({"years": [2024, 2019, 2014]}))
        with mock.patch.object(json, "dump", _dies_halfway):
            outcome = _run_census(folder)
        self.assertIsInstance(outcome, OSError)
        self.assert_manifest_describes_folder(folder)


def _git(*args):
    return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True)


def _has_git():
    return shutil.which("git") is not None and _git("rev-parse", "--is-inside-work-tree").returncode == 0


# a run that is killed cannot clean up its staging folder, so whatever it
# stages under data/raw has to be something .gitignore already covers, or a
# later git add data/raw commits it
@unittest.skipUnless(_has_git(), "needs git and the repo's work tree")
class TestWhatADownloadStagesIsIgnored(unittest.TestCase):
    # every path main renames out of, as the path it would be in this repo
    @contextlib.contextmanager
    def staged_paths(self, folder, source):
        staged, real = [], os.replace

        def replace(src, dst, *args, **kwargs):
            if folder in Path(src).parents:
                staged.append(Path("data", "raw", source, Path(src).relative_to(folder)).as_posix())
            return real(src, dst, *args, **kwargs)

        with mock.patch.object(os, "replace", replace):
            yield staged

    def assert_ignored(self, staged):
        self.assertTrue(staged, "the run staged nothing this test could see")
        result = [path for path in staged if _git("check-ignore", "--no-index", "-q", path).returncode != 0]
        self.assertEqual(result, [], "staged under data/raw and not ignored by .gitignore")

    def folder(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return Path(tmp.name)

    def test_download_fhfa(self):
        folder = self.folder()
        with self.staged_paths(folder, "fhfa") as staged, \
             mock.patch.object(dfhfa, "RAW_DIR", folder), \
             mock.patch.object(dfhfa, "requests", _fhfa_site()), \
             contextlib.redirect_stdout(io.StringIO()):
            dfhfa.main()
        self.assert_ignored(staged)

    def test_download_census(self):
        folder = self.folder()
        (folder / "vintages.json").write_text(json.dumps({"years": [2024, 2019, 2014]}))
        with self.staged_paths(folder, "census") as staged:
            self.assertIsNone(_run_census(folder))
        self.assert_ignored(staged)


# vintages.json names the vintages on disk and moves only with them. a
# --refresh-vintages run that fails leaves it byte for byte, one that lands
# every vintage moves it
class TestAFailedRefreshLeavesThePin(unittest.TestCase):
    CATALOG = {"dataset": [{"c_dataset": ["acs", "acs5"], "c_vintage": 2025}]}

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name)
        self.pin = self.folder / "vintages.json"
        self.pin.write_text(json.dumps({"years": [2024, 2019, 2014]}) + "\n")
        self.before = self.pin.read_bytes()

    def refresh(self, **patches):
        return _run_census(self.folder, ["--refresh-vintages"],
                           fetch_catalog=mock.Mock(return_value=self.CATALOG), **patches)

    def test_a_refresh_whose_vintages_fail_leaves_the_pin(self):
        outcome = self.refresh(fetch_acs_data=mock.Mock(side_effect=RuntimeError("census answered html")))
        self.assertIsInstance(outcome, SystemExit)
        self.assertEqual(self.pin.read_bytes(), self.before)

    def test_a_refresh_with_no_key_leaves_the_pin(self):
        outcome = self.refresh(load_api_key=mock.Mock(side_effect=RuntimeError("CENSUS_API_KEY is not set")))
        self.assertIsInstance(outcome, RuntimeError)
        self.assertEqual(self.pin.read_bytes(), self.before)

    def test_a_refresh_that_lands_every_vintage_moves_the_pin(self):
        self.assertIsNone(self.refresh())
        self.assertEqual(json.loads(self.pin.read_text())["years"], [2025, 2020, 2015])


if __name__ == "__main__":
    unittest.main()

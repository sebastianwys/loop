# vintages.json names the acs vintages the census archive and its manifest
# hold, and it moves only with them. a --refresh-vintages run that fails
# leaves the pin where it was: a pin moved while the files and the manifest
# stay on the old years would let the next plain run move the study window
# without the flag. the catalog, the key and the api are stubs, the folder is
# temporary

import contextlib
import io
import json
import os
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

PINNED = [2024, 2019, 2014]

# census has published a newer vintage since the pin was written
CATALOG = {"dataset": [{"c_dataset": ["acs", "acs5"], "c_vintage": 2025}]}


def acs_frame(year):
    return pd.DataFrame([{
        "NAME": "Abilene, TX Metro Area", "B19013_001E": "61000", "B01003_001E": "170000",
        "B01002_001E": "34.5", "B15003_001E": "100000", "B15003_022E": "20000",
        "B15003_023E": "6000", "B25003_001E": "63000", "B25003_002E": "40000",
        "B25077_001E": "150000", dc.MSA_COL: "10180", dc.DIV_COL: "",
        "geo_level": "msa", "geo_code": "10180", "parent_cbsa": "", "year": year,
    }])


# every call the api would get fails to connect
class Unreachable:
    HTTPError = requests.HTTPError

    def get(self, url, params=None, timeout=None):
        raise requests.ConnectionError("stubbed outage")


class TestAFailedRefreshLeavesThePin(unittest.TestCase):
    maxDiff = None

    # the archive a refresh starts from: the pin, the three vintages it names
    # and a manifest describing them, the way download_census leaves it
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name) / "census"
        self.folder.mkdir()
        pin = {"years": PINNED, "windows": {str(y): list(dc.window(y)) for y in PINNED},
               "span": dc.SPAN, "latest_available": PINNED[0], "catalog": dc.CATALOG_URL,
               "resolved_at": "2026-09-14T22:43:21Z"}
        (self.folder / "vintages.json").write_text(json.dumps(pin, indent=2) + "\n")
        for year in PINNED:
            acs_frame(year).to_csv(self.folder / f"acs_5yr_{year}.csv", index=False)
        (self.folder / "download_manifest.json").write_text(json.dumps(
            [{"filename": f"acs_5yr_{y}.csv", "version": f"ACS 5-year {y}"} for y in sorted(PINNED)], indent=2))
        self.before = (self.folder / "vintages.json").read_bytes()

    def refresh(self, environment, **patches):
        env = {k: v for k, v in os.environ.items() if k not in ("CENSUS_API_KEY", "CENSUS_ENV_FILE")}
        env.update(environment)
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(dc, "RAW_DIR", self.folder), \
             mock.patch.object(dc, "VINTAGES_FILE", self.folder / "vintages.json"), \
             mock.patch.object(dc, "fetch_catalog", return_value=CATALOG), \
             mock.patch.object(sys, "argv", ["download_census.py", "--refresh-vintages"]), \
             contextlib.ExitStack() as stack, \
             contextlib.redirect_stdout(io.StringIO()):
            for name, value in patches.items():
                stack.enter_context(mock.patch.object(dc, name, value))
            try:
                dc.main()
            except (Exception, SystemExit) as error:
                return error
        return None

    def pinned_years(self):
        return json.loads((self.folder / "vintages.json").read_text())["years"]

    def held(self):
        return [entry["version"] for entry in json.loads((self.folder / "download_manifest.json").read_text())]

    def assert_pin_unmoved(self):
        self.assertEqual(self.pinned_years(), PINNED,
                         f"the pin moved while the archive and its manifest still hold {self.held()}")
        self.assertEqual((self.folder / "vintages.json").read_bytes(), self.before)

    def test_a_refresh_with_no_key_leaves_the_pin(self):
        outcome = self.refresh({})
        self.assertIsInstance(outcome, RuntimeError)
        self.assertIn("CENSUS_API_KEY is not set", str(outcome))
        self.assert_pin_unmoved()

    def test_a_refresh_that_cannot_reach_the_api_leaves_the_pin(self):
        outcome = self.refresh({"CENSUS_API_KEY": "synthetic-key"}, requests=Unreachable())
        self.assertIsInstance(outcome, SystemExit)
        self.assertIn("The previous combined csv and manifest were left in place", str(outcome))
        self.assert_pin_unmoved()

    # the control: a refresh that lands every vintage moves the
    # pin, publishes the new years and drops the one that left the study
    def test_a_refresh_that_lands_every_vintage_moves_the_pin(self):
        outcome = self.refresh({"CENSUS_API_KEY": "synthetic-key"},
                               fetch_acs_data=mock.Mock(side_effect=lambda year, key: acs_frame(year)))
        self.assertIsNone(outcome)
        self.assertEqual(self.pinned_years(), [2025, 2020, 2015])
        self.assertEqual(self.held(), ["ACS 5-year 2015", "ACS 5-year 2020", "ACS 5-year 2025"])
        self.assertFalse((self.folder / "acs_5yr_2014.csv").exists())


if __name__ == "__main__":
    unittest.main()

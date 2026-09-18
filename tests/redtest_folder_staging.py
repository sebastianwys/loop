# a red test. run_tests.py discovers test*.py, so this one runs on its own:
#   ml/.venv/bin/python -m unittest tests.redtest_folder_staging -v

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from bot.common import sha256_file
from bot.collectors import hud
from tests.test_hud import MEMBERSHIP, MERGED, TOKEN, FakeHud, fake_census

# what a previous run left in the folder. hud writes one raw json per fiscal
# year inside the year loop and its metrics table at the end, so the table is
# the last thing to land and the first thing a reader would notice missing
PREVIOUS_RAW = '{"year": 2019, "fmr": {}, "il": {}, "states": {}}\n'
PREVIOUS_METRICS = "cbsa_code,metric,period,value\n10180,fmr_2br,2019,801.0\n"


def dying_to_csv(self, path_or_buf=None, *args, **kwargs):
    Path(path_or_buf).write_text("cbsa_code,metric,period,value\n10180,fmr")
    raise OSError("no space left on device")


# a collector replaces its folder whole or not at all. one file at a time is
# not enough when a run writes several: a run that dies between two of them
# leaves some of this run's files beside some of the last one's, under a
# manifest that describes neither set
class TestAFolderIsReplacedWholeOrNotAtAll(FakeHud, unittest.TestCase):
    membership = MEMBERSHIP

    @contextlib.contextmanager
    def folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "hud"
            out_dir.mkdir()
            (out_dir / "hud_2019.json").write_text(PREVIOUS_RAW)
            (out_dir / "metrics.csv").write_text(PREVIOUS_METRICS)
            merged = Path(tmp) / "merged.csv"
            merged.write_text(MERGED)
            counties = Path(tmp) / "cbsa_counties.csv"
            counties.write_text(self.membership)
            with patch.dict(os.environ, {"HUD_API_TOKEN": TOKEN}), \
                    patch.object(hud, "INTEGRATED", merged), \
                    patch.object(hud, "OUT_DIR", out_dir), \
                    patch.object(hud, "OUT_FILE", out_dir / "metrics.csv"), \
                    patch.object(hud, "MEMBERSHIP", counties), \
                    patch("bot.collectors.hud.fetch", side_effect=fake_census), \
                    patch("bot.collectors.hud.requests.get", side_effect=self.fake_get), \
                    patch("bot.collectors.hud.time.sleep"), \
                    contextlib.redirect_stdout(io.StringIO()):
                yield out_dir

    # the control: a run that finishes replaces both
    def test_a_run_that_finishes_replaces_the_raw_year_and_the_table(self):
        with self.folder() as out_dir:
            hud.collect()
            self.assertNotEqual((out_dir / "hud_2019.json").read_text(), PREVIOUS_RAW)
            self.assertGreater(len(pd.read_csv(out_dir / "metrics.csv")), 1)

    def test_a_run_that_dies_on_the_table_leaves_the_raw_years_alone(self):
        with self.folder() as out_dir:
            with patch.object(pd.DataFrame, "to_csv", dying_to_csv), self.assertRaises(OSError):
                hud.collect()
            self.assertEqual((out_dir / "hud_2019.json").read_text(), PREVIOUS_RAW,
                             "this run's raw years landed beside the last run's table")
            self.assertEqual((out_dir / "metrics.csv").read_text(), PREVIOUS_METRICS)

    # and the manifest still describes the files that are actually there
    def test_the_folder_holds_one_run_s_files(self):
        with self.folder() as out_dir:
            hud.collect()
            entries = json.loads((out_dir / "download_manifest.json").read_text())
            before = {e["filename"]: e["integrity"]["sha256"] for e in entries}
            with patch.object(pd.DataFrame, "to_csv", dying_to_csv), self.assertRaises(OSError):
                hud.collect()
            entries = json.loads((out_dir / "download_manifest.json").read_text())
            after = {e["filename"]: e["integrity"]["sha256"] for e in entries}
            self.assertEqual(after, before)
            for name, digest in after.items():
                self.assertEqual(sha256_file(out_dir / name), digest, name)


if __name__ == "__main__":
    unittest.main()

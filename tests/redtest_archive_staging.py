# a red test. run_tests.py discovers test*.py, so this one runs on its own:
#   ml/.venv/bin/python -m unittest tests.redtest_archive_staging -v

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import pandas as pd

from bot import common
from bot.collectors import fred

# the archive a previous run left. every raw file under data/raw is the only
# copy the pipeline has of a vintage the publisher does not keep, which is why
# the collectors were taught to refuse a bad body rather than write it
PREVIOUS = "date,value\n2026-09-03,6.5\n2026-09-10,6.4\n"

OBSERVATIONS = {"observations": [
    {"date": "2026-09-03", "value": "6.5"},
    {"date": "2026-09-10", "value": "6.4"},
    {"date": "2026-09-17", "value": "6.3"},
]}


# a to_csv that gets part of the frame down and then dies, which is a disk
# filling up, a container stopped, or a machine losing power mid-write
def dying_to_csv(self, path_or_buf=None, *args, **kwargs):
    Path(path_or_buf).write_text("date,value\n2026-09-03,6.")
    raise OSError("no space left on device")


def dying_write_text(self, text, *args, **kwargs):
    Path(self).write_bytes(text[: len(text) // 2].encode())
    raise OSError("no space left on device")


class TestTheArchiveSurvivesAFailedWrite(unittest.TestCase):
    @contextlib.contextmanager
    def collector(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "fred"
            out_dir.mkdir()
            out_file = out_dir / "mortgage30us.csv"
            out_file.write_text(PREVIOUS)
            response = Mock(ok=True, status_code=200)
            response.json = Mock(return_value=OBSERVATIONS)
            with patch.dict(os.environ, {"FRED_API_KEY": "synthetic-key"}), \
                    patch.object(fred, "OUT_DIR", out_dir), \
                    patch.object(fred, "OUT_FILE", out_file), \
                    patch("bot.collectors.fred.fetch", return_value=response), \
                    contextlib.redirect_stdout(io.StringIO()):
                yield out_dir, out_file

    # the control: a run that finishes replaces the archive
    def test_a_run_that_finishes_writes_the_new_observations(self):
        with self.collector() as (_, out_file):
            fred.collect()
            self.assertEqual(len(pd.read_csv(out_file)), 3)

    def test_a_write_that_dies_partway_leaves_the_previous_archive_whole(self):
        with self.collector() as (_, out_file):
            with patch.object(pd.DataFrame, "to_csv", dying_to_csv), self.assertRaises(OSError):
                fred.collect()
            self.assertEqual(out_file.read_text(), PREVIOUS,
                             "the only copy of this vintage was truncated in place")

    # and nothing half written is left lying in the folder for the next run,
    # or for the manifest, to pick up as if it were an archive
    def test_a_failed_write_leaves_no_half_file_behind(self):
        with self.collector() as (out_dir, _):
            with patch.object(pd.DataFrame, "to_csv", dying_to_csv), self.assertRaises(OSError):
                fred.collect()
            self.assertEqual(sorted(p.name for p in out_dir.iterdir()), ["mortgage30us.csv"])


class TestTheManifestSurvivesAFailedWrite(unittest.TestCase):
    def entries(self, version):
        return [{"filename": "mortgage30us.csv", "version": version,
                 "source": {"url": "https://example.org/fred", "provider": "FRED"},
                 "integrity": {"sha256": "abc123", "row_count": 2},
                 "downloaded_at": "2026-09-16T00:00:00Z"}]

    def test_a_manifest_write_that_dies_partway_leaves_the_previous_manifest_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            path = common.write_manifest(folder, self.entries("through 2026-09-10"))
            before = path.read_text()
            with patch.object(Path, "write_text", dying_write_text), self.assertRaises(OSError):
                common.write_manifest(folder, self.entries("through 2026-09-17"))
            # build_map_data.read_manifest returns none for a manifest that will
            # not parse, so the folder drops off the provenance block entirely
            self.assertEqual(path.read_text(), before,
                             "the manifest naming every file in the folder was truncated in place")
            self.assertEqual(json.loads(path.read_text())[0]["version"], "through 2026-09-10")


if __name__ == "__main__":
    unittest.main()

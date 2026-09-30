# a red test. run from the project root:
#   ml/.venv/bin/python -m unittest tests/redtest_folder_commit.py -v
#
# staged_folder writes a collector's whole run under a staging directory and
# lands nothing until the body reaches the end, so a body that raises leaves
# the previous vintage entire. the landing itself, Landing.commit, is one
# os.replace per file, and a filesystem renames one file at a time. a rename
# that fails partway through that loop, or a run killed inside it, leaves this
# run's first files beside the last run's others, under the last run's
# manifest. the window is milliseconds wide against the whole run the staging
# closed.
#
# two ways to stop the loop partway: a rename that raises on its second call,
# and a run killed at the same place, in a fresh interpreter that sends itself
# SIGKILL. nothing in a process can run after a kill to put the folder back.
#
# this stays red. it is a documented limitation, written up at
# Landing.commit, not a defect waiting on a fix: putting the replaced files
# back would close only the first test, and closing the second takes a
# journal every reader of data/raw checks

import json
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from bot import common

ROOT = Path(__file__).resolve().parent.parent

KILLED = r'''
import json
import os
import signal
import sys
from pathlib import Path

from bot import common

real, calls = os.replace, []


def killed_second(src, dst, *args, **kwargs):
    calls.append(dst)
    if len(calls) == 2:
        os.kill(os.getpid(), signal.SIGKILL)
    return real(src, dst, *args, **kwargs)


os.replace = killed_second
with common.staged_folder(Path(sys.argv[1])) as landing:
    landing.text("metrics.csv", "new metrics\n")
    landing.text("hud_2019.json", "new raw\n")
    landing.manifest([{"filename": "metrics.csv", "integrity": {"sha256": "NEW"}}])
'''

# a manifest in the shape Landing.manifest writes it
def manifest(sha):
    return json.dumps([{"filename": "metrics.csv", "integrity": {"sha256": sha}}], indent=2) + "\n"


OLD = {"metrics.csv": "old metrics\n", "hud_2019.json": "old raw\n", common.MANIFEST_FILE: manifest("OLD")}
NEW = {"metrics.csv": "new metrics\n", "hud_2019.json": "new raw\n", common.MANIFEST_FILE: manifest("NEW")}


class TestAnInterruptedLandingLeavesOneRunsFolder(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name) / "hud"
        self.folder.mkdir()
        for name, text in OLD.items():
            (self.folder / name).write_text(text)

    def land(self):
        with common.staged_folder(self.folder) as landing:
            landing.text("metrics.csv", NEW["metrics.csv"])
            landing.text("hud_2019.json", NEW["hud_2019.json"])
            landing.manifest(json.loads(NEW[common.MANIFEST_FILE]))

    def on_disk(self):
        return {p.name: p.read_text() for p in sorted(self.folder.iterdir()) if p.is_file()}

    def test_a_rename_that_fails_partway_leaves_one_runs_files(self):
        real, calls = os.replace, []

        def fails_second(src, dst, *args, **kwargs):
            calls.append(Path(dst).name)
            if len(calls) == 2:
                raise OSError("input/output error")
            return real(src, dst, *args, **kwargs)

        with mock.patch.object(common.os, "replace", fails_second), self.assertRaises(OSError):
            self.land()
        folder = self.on_disk()
        self.assertIn(folder, (OLD, NEW), "one run's files beside the other run's, under the old manifest")

    @unittest.skipUnless(hasattr(signal, "SIGKILL"), "needs SIGKILL")
    def test_a_run_killed_partway_leaves_one_runs_files(self):
        result = subprocess.run([sys.executable, "-c", KILLED, str(self.folder)], cwd=ROOT,
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, -signal.SIGKILL, result.stderr)
        self.assertIn(self.on_disk(), (OLD, NEW), "one run's files beside the other run's, under the old manifest")

    # the control, green today: a landing that is not interrupted is whole
    def test_a_landing_that_finishes_is_one_runs_files(self):
        self.land()
        self.assertEqual(self.on_disk(), NEW)


if __name__ == "__main__":
    unittest.main()

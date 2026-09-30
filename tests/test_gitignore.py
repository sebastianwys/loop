import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from bot import common

REPO = Path(__file__).resolve().parent.parent


def _git(*args):
    return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True)


def _has_git():
    return shutil.which("git") is not None and _git("rev-parse", "--is-inside-work-tree").returncode == 0


# a body on its way to an archive or an artifact is never tracked or published.
# replace_atomically stages it beside its destination and a run that is killed
# leaves it there, so every folder it stages into has to ignore the staged name
@unittest.skipUnless(_has_git(), "needs git and the repo's work tree")
class TestAStagedBodyIsIgnored(unittest.TestCase):
    # the name replace_atomically actually stages a destination under, as the
    # path it would be in this repo
    def staged(self, destination):
        seen = []
        with tempfile.TemporaryDirectory() as tmp:
            common.replace_atomically(Path(tmp) / destination.name,
                                      lambda staged: (seen.append(staged.name), staged.write_text("{}\n")))
        return (destination.parent / seen[0]).relative_to(common.BASE_DIR).as_posix()

    def assert_ignored(self, path):
        self.assertEqual(_git("check-ignore", "--no-index", "-q", path).returncode, 0, f"{path} is not ignored")

    # both workflows commit web/public/data, and vite ships web/public
    def test_the_map_payload(self):
        self.assert_ignored(self.staged(common.WEB_DATA_DIR / "metros.json"))

    def test_a_collector_table(self):
        self.assert_ignored(self.staged(common.RAW_DIR / "fred" / "metrics.csv"))


if __name__ == "__main__":
    unittest.main()

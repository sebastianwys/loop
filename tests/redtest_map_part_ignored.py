# a red test, the .gitignore half. run
# from the project root:
#   ml/.venv/bin/python -m unittest tests/redtest_map_part_ignored.py -v
#
# build_map_data writes web/public/data/metros.json through
# bot.common.replace_atomically, which stages the body beside it under a .part
# name. a build that is killed leaves that file behind, and .gitignore covers
# .part names under data/raw only, while bot.yml and national.yml both commit
# web/public/data and vite copies web/public into the deployed site.
#
# the staged name is the one replace_atomically actually uses, taken off a
# write to a temporary file, then put to the repo's own .gitignore through git
# check-ignore. nothing under web/ is written

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from bot import common

ROOT = Path(__file__).resolve().parent.parent


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)


# exit 0 is ignored, 1 is not, anything else is git failing
def ignored(relpath):
    result = git("check-ignore", "--no-index", "-q", relpath)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr)
    return result.returncode == 0


# the name replace_atomically stages a destination under
def staged_name(destination):
    seen = []
    with tempfile.TemporaryDirectory() as tmp:
        common.replace_atomically(Path(tmp) / destination.name,
                                  lambda staged: (seen.append(staged.name), staged.write_text("{}\n")))
    return seen[0]


def staged_path(destination):
    return (destination.parent / staged_name(destination)).relative_to(common.BASE_DIR).as_posix()


@unittest.skipUnless(shutil.which("git") and git("rev-parse", "--is-inside-work-tree").returncode == 0,
                     "needs git and the repo's work tree")
class TestTheMapsStagedBodyIsIgnored(unittest.TestCase):
    def test_the_staged_metros_json_is_ignored(self):
        path = staged_path(common.WEB_DATA_DIR / "metros.json")
        self.assertTrue(ignored(path), f"{path} is not ignored, and both workflows commit web/public/data")

    # the control, green today: a collector's staged body under data/raw
    def test_a_collectors_staged_body_is_ignored(self):
        self.assertTrue(ignored(staged_path(common.RAW_DIR / "fred" / "mortgage30us.csv")))


if __name__ == "__main__":
    unittest.main()

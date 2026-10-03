# both scripts/ collectors stage a run in a temporary directory inside
# data/raw/<source>. a run that dies cleans the folder up, a run that is killed
# cannot, and what it leaves would be untracked data a later git add data/raw
# commits, so every path a run stages has to be one .gitignore covers.
#
# every path a run stages is recorded as it is renamed toward the archive, then
# put to the repo's own .gitignore through git check-ignore. the collectors run
# on temporary folders with the network stubbed. git only reads .gitignore

import contextlib
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

ROOT = Path(__file__).resolve().parent.parent

# scripts/ is not a package, so put it on the path before importing
sys.path.insert(0, str(ROOT / "scripts"))

import download_census as dc
import download_fhfa as dfhfa

MASTER = (
    "hpi_type,hpi_flavor,frequency,level,place_name,place_id,yr,period,"
    "index_nsa,index_sa,rstderr,note\n"
    "traditional,purchase-only,quarterly,MSA,\"Abilene, TX\",10180,2026,3,266.00,267.00,,\n"
)
METRO = "city\tmetro_name\tyr\tqtr\tindex_nsa\nAbilene\tAbilene TX\t2026\t3\t266.00\n"


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)


# exit 0 is ignored, 1 is not, anything else is git failing
def ignored(relpath):
    result = git("check-ignore", "--no-index", "-q", relpath)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr)
    return result.returncode == 0


class FhfaSite:
    def get(self, url):
        response = mock.Mock()
        response.content = (MASTER if url.endswith(".csv") else METRO).encode()
        response.raise_for_status.return_value = None
        return response


def acs_frame(year):
    return pd.DataFrame([{
        "NAME": "Abilene, TX Metro Area", "B19013_001E": "61000", "B01003_001E": "170000",
        "B01002_001E": "34.5", "B15003_001E": "100000", "B15003_022E": "20000",
        "B15003_023E": "6000", "B25003_001E": "63000", "B25003_002E": "40000",
        "B25077_001E": "150000", dc.MSA_COL: "10180", dc.DIV_COL: "",
        "geo_level": "msa", "geo_code": "10180", "parent_cbsa": "", "year": year,
    }])


@unittest.skipUnless(shutil.which("git") and git("rev-parse", "--is-inside-work-tree").returncode == 0,
                     "needs git and the repo's work tree")
class TestWhatACollectorStagesIsIgnored(unittest.TestCase):
    # every path main renames out of, recorded while the run is under way, as
    # the path it would be inside data/raw/<source> of this repo
    @contextlib.contextmanager
    def recording(self, folder, source):
        staged, real = [], os.replace

        def replace(src, dst, *args, **kwargs):
            src = Path(src)
            if folder in src.parents:
                staged.append(Path("data", "raw", source, src.relative_to(folder)).as_posix())
            return real(src, dst, *args, **kwargs)

        with mock.patch.object(os, "replace", replace):
            yield staged

    def folder(self, source):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        folder = Path(tmp.name) / source
        folder.mkdir()
        return folder

    def assert_all_ignored(self, staged):
        self.assertTrue(staged, "the run staged nothing this test could see")
        self.assertEqual([path for path in staged if not ignored(path)], [],
                         "staged under data/raw and not ignored by .gitignore")

    def test_what_download_fhfa_stages_is_ignored(self):
        folder = self.folder("fhfa")
        with self.recording(folder, "fhfa") as staged, \
             mock.patch.object(dfhfa, "RAW_DIR", folder), \
             mock.patch.object(dfhfa, "requests", FhfaSite()), \
             contextlib.redirect_stdout(io.StringIO()):
            dfhfa.main()
        self.assert_all_ignored(staged)

    def test_what_download_census_stages_is_ignored(self):
        folder = self.folder("census")
        (folder / "vintages.json").write_text(json.dumps({"years": [2024, 2019, 2014]}))
        with self.recording(folder, "census") as staged, \
             mock.patch.object(dc, "RAW_DIR", folder), \
             mock.patch.object(dc, "VINTAGES_FILE", folder / "vintages.json"), \
             mock.patch.object(dc, "load_api_key", return_value="synthetic-key"), \
             mock.patch.object(dc, "fetch_acs_data", side_effect=lambda year, key: acs_frame(year)), \
             mock.patch.object(sys, "argv", ["download_census.py"]), \
             contextlib.redirect_stdout(io.StringIO()):
            dc.main()
        self.assert_all_ignored(staged)

    # the control: the shape bot.common.staged_folder stages in
    def test_the_bot_staging_shape_is_ignored(self):
        self.assertTrue(ignored("data/raw/fhfa/.staging-abcd1234/hpi_master.csv"))
        self.assertTrue(ignored("data/raw/fhfa/.staging-abcd1234/hpi_master.csv.part"))


if __name__ == "__main__":
    unittest.main()

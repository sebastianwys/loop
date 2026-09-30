# a red test. run_tests.py discovers test*.py, so this one runs on its own:
#   ml/.venv/bin/python -m unittest tests.redtest_national_zillow_manifest -v

import json
import re
import unittest
from pathlib import Path

# the zillow csvs are gitignored, so data/raw/zillow/download_manifest.json is
# the repo's only record of which zillow vintage the committed map was built
# on, and the map's provenance block prints its row verbatim. the weekday
# national workflow runs the zillow collector so the rebuild has the csvs, and
# the collector rewrites that manifest whenever zillow's files have moved. the
# map rebuilt from them is then committed and published. whatever a workflow's
# collectors write has to go into the commit that workflow makes, or the
# committed map cites a manifest the repo does not hold.
#
# e220182 is one: a national strip refresh that moved sources.zillow from
# "through 2026-07-31" to "through 2026-08-31" while the manifest committed
# beside it stayed at 2026-07-31, until a hand commit caught it up a day later
REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "national.yml"
METROS = REPO_ROOT / "web" / "public" / "data" / "metros.json"
ZILLOW_MANIFEST = REPO_ROOT / "data" / "raw" / "zillow" / "download_manifest.json"


# git-auto-commit hands file_pattern to git add as pathspecs, so a folder
# covers every path under it
def covered(path, patterns):
    return any(path == p.rstrip("/") or path.startswith(p.rstrip("/") + "/") for p in patterns)


class TestTheNationalCommitCarriesWhatItsCollectorsWrote(unittest.TestCase):
    def setUp(self):
        text = WORKFLOW.read_text()
        only = re.search(r"python -m bot\.run_bot --only ([\w ]+)", text)
        pattern = re.search(r'file_pattern:\s*"([^"]*)"', text)
        self.collectors = only.group(1).split() if only else []
        self.pattern = pattern.group(1).split() if pattern else []

    # the parse itself, so an edit that moves either line cannot pass this
    # file by leaving it nothing to compare
    def test_the_workflow_names_its_collectors_and_what_it_commits(self):
        self.assertTrue(self.collectors)
        self.assertTrue(self.pattern)

    def test_every_manifest_the_run_writes_is_in_its_commit(self):
        uncommitted = [name for name in self.collectors
                       if not covered(f"data/raw/{name}/download_manifest.json", self.pattern)]
        self.assertEqual(uncommitted, [], f"the commit step adds only {self.pattern}")


# why the manifest is load-bearing: the committed map carries zillow's
# manifest row, vintage and hash. this holds at HEAD only because a hand commit
# brought the manifest level after the national run had moved the map
class TestTheCommittedMapCitesTheCommittedZillowManifest(unittest.TestCase):
    def test_the_zillow_provenance_row_is_the_committed_manifest_row(self):
        row = [r for r in json.loads(METROS.read_text()).get("provenance", []) if r.get("source") == "zillow"]
        first = json.loads(ZILLOW_MANIFEST.read_text())[0]
        self.assertEqual(len(row), 1)
        self.assertEqual((row[0]["filename"], row[0]["version"], row[0]["sha256"]),
                         (first["filename"], first["version"], first["integrity"]["sha256"]))


if __name__ == "__main__":
    unittest.main()

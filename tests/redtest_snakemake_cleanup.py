# a red test. run_tests.py discovers test*.py, so this one runs on its own:
#   ml/.venv/bin/python -m unittest tests.redtest_snakemake_cleanup -v

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# the workflow under test is copied out of the repo and driven inside a
# throwaway tree. no rule here ever names a path under the real data directory
REPO_ROOT = Path(__file__).parent.parent
SNAKEFILE = REPO_ROOT / "Snakefile"

# what a collector leaves behind when it refuses the body: nothing at all.
# this is download_file exiting non zero after _validate rejects a maintenance
# page, the archive safety the scripts already implement
FAILING_COLLECTOR = (
    "import sys\n"
    "\n"
    "print('came back as html, usually a maintenance page')\n"
    "sys.exit(1)\n"
)

FHFA_FILES = {
    "hpi_master.csv": (
        "hpi_type,place_id,yr,period,index_nsa\n"
        "traditional,10180,2026,2,264.64\n"
    ),
    "hpi_exp_metro.txt": (
        "city\tmetro_name\tyr\tqtr\tindex_nsa\n"
        "Abilene\tAbilene TX\t2026\t2\t264.64\n"
    ),
    "download_manifest.json": '[{"filename": "hpi_master.csv"}]\n',
}

CENSUS_YEARS = [2024, 2019, 2014]

CENSUS_FILES = {
    "acs_5yr_%d.csv" % year: "NAME,year\nAbilene TX Metro Area,%d\n" % year
    for year in CENSUS_YEARS
}
CENSUS_FILES["acs_5yr_combined.csv"] = "NAME,year\nAbilene TX Metro Area,2024\n"
CENSUS_FILES["download_manifest.json"] = '[{"filename": "acs_5yr_combined.csv"}]\n'

# the pinned vintages the workflow reads to build the census dag
VINTAGES = json.dumps({"years": CENSUS_YEARS, "span": 5})


# a collector that does publish, so the clean path proves the harness works
def working_collector(names):
    return (
        "from pathlib import Path\n"
        "\n"
        "for name in %r:\n"
        "    path = Path(name)\n"
        "    path.parent.mkdir(parents=True, exist_ok=True)\n"
        "    path.write_text('fresh vintage\\n')\n" % (names,)
    )


def find_snakemake():
    beside = Path(sys.executable).parent / "snakemake"
    if beside.exists():
        return beside
    found = shutil.which("snakemake")
    return Path(found) if found else None


class WorkflowTreeCase(unittest.TestCase):
    def setUp(self):
        binary = find_snakemake()
        if binary is None:
            self.skipTest("snakemake is not installed for this interpreter")
        self.snakemake = binary
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tree = Path(tmp.name).resolve()
        # the run must never be able to reach the archive it stands in for
        self.assertNotIn(REPO_ROOT.resolve(), self.tree.parents)
        (self.tree / "scripts").mkdir()
        (self.tree / "Snakefile").write_text(SNAKEFILE.read_text())

    # lay out a raw archive the way the last good run left it
    def lay_out(self, source, files):
        directory = self.tree / "data" / "raw" / source
        directory.mkdir(parents=True, exist_ok=True)
        for name, text in files.items():
            (directory / name).write_text(text)
        return directory

    # name -> what is on disk now, None once the file is gone
    def on_disk(self, directory, names):
        return {
            name: (directory / name).read_text()
            if (directory / name).exists()
            else None
            for name in names
        }

    def write_collector(self, name, body):
        (self.tree / "scripts" / name).write_text(body)

    def run_rule(self, rule):
        command = [
            str(self.snakemake),
            rule,
            "--snakefile", str(self.tree / "Snakefile"),
            "--directory", str(self.tree),
            "--cores", "1",
            "--forcerun", rule,
        ]
        return subprocess.run(
            command, cwd=str(self.tree), capture_output=True, text=True, timeout=300
        )


# hpi_master.csv has no vintage parameter, so the archived copy IS the vintage
# and cannot be fetched again once it is gone. the collector refuses a bad body
# without writing anything, and the workflow that calls it must not carry out
# the deletion the collector declined to make
class TestFhfaArchiveSurvivesAFailedRule(WorkflowTreeCase):
    def run_refused_download(self):
        archive = self.lay_out("fhfa", FHFA_FILES)
        before = self.on_disk(archive, FHFA_FILES)
        self.write_collector("download_fhfa.py", FAILING_COLLECTOR)
        return archive, before, self.run_rule("download_fhfa")

    def test_a_refused_download_leaves_every_archived_file(self):
        archive, before, result = self.run_refused_download()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.on_disk(archive, FHFA_FILES), before)

    def test_a_refused_download_leaves_the_archive_directory(self):
        archive, _, _ = self.run_refused_download()
        self.assertTrue(archive.is_dir())

    # keeping the archive must not cost us the ability to publish a real pull
    def test_a_clean_download_publishes_the_new_vintage(self):
        archive = self.lay_out("fhfa", FHFA_FILES)
        self.write_collector(
            "download_fhfa.py",
            working_collector(["data/raw/fhfa/" + name for name in FHFA_FILES]),
        )
        result = self.run_rule("download_fhfa")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            self.on_disk(archive, FHFA_FILES),
            {name: "fresh vintage\n" for name in FHFA_FILES},
        )


# the acs pulls are pinned vintages too, and the census api stops serving an
# end year once it is retired. a run that answers html must not cost the
# archive the years it already holds
class TestCensusArchiveSurvivesAFailedRule(WorkflowTreeCase):
    def run_refused_download(self):
        archive = self.lay_out("census", CENSUS_FILES)
        # vintages.json is not a rule output, it only pins the years in the dag
        (archive / "vintages.json").write_text(VINTAGES)
        before = self.on_disk(archive, CENSUS_FILES)
        self.write_collector("download_census.py", FAILING_COLLECTOR)
        return archive, before, self.run_rule("download_census")

    def test_a_refused_download_leaves_every_archived_file(self):
        archive, before, result = self.run_refused_download()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.on_disk(archive, CENSUS_FILES), before)


if __name__ == "__main__":
    unittest.main()

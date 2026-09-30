# a red test. run_tests.py discovers test*.py, so this one runs on its own:
#   ml/.venv/bin/python -m unittest tests.redtest_snakemake_dag -v

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

# docs/REPORT.md lists `snakemake --cores 1` as the recommended way to run the
# pipeline, "three rules, re-runs only what changed", with the same outputs as
# run_all.py, which downloads fhfa, downloads census and then integrates. the
# download rules take part in that run only if rule all can reach them.
#
# every case here only plans (--dry-run). no rule's shell command runs, so
# nothing is downloaded and no script is called. the throwaway tree holds a
# copy of the Snakefile and the few files the plan looks at
REPO_ROOT = Path(__file__).resolve().parent.parent
SNAKEFILE = REPO_ROOT / "Snakefile"
VINTAGES = REPO_ROOT / "data" / "raw" / "census" / "vintages.json"

DOWNLOADS = ["download_census", "download_fhfa"]

# the pinned acs end years, which name the census files
YEARS = json.loads(VINTAGES.read_text())["years"]

# every file each collector writes, as the last good download left them. the
# list is written out here rather than read from the Snakefile: a whole archive
# is what the collectors leave behind, whatever outputs the rules declare
ARCHIVE = {
    "fhfa": {
        "hpi_master.csv": "hpi_type,place_id,yr,period,index_nsa\ntraditional,10180,2026,2,264.64\n",
        "hpi_exp_metro.txt": "city\tmetro_name\tyr\tqtr\tindex_nsa\nAbilene\tAbilene TX\t2026\t2\t264.64\n",
        "download_manifest.json": '[{"filename": "hpi_master.csv"}]\n',
    },
    "census": {
        **{"acs_5yr_%d.csv" % year: "NAME,year\nAbilene TX Metro Area,%d\n" % year for year in YEARS},
        "acs_5yr_combined.csv": "NAME,year\nAbilene TX Metro Area,2024\n",
        "download_manifest.json": '[{"filename": "acs_5yr_combined.csv"}]\n',
    },
}

# what rule integrate builds from the archive
INTEGRATED = [
    "data/integrated/hpi_census_merged.csv",
    "results/visualizations/hpi_distribution.png",
    "results/visualizations/income_vs_hpi.png",
    "results/visualizations/homeownership_vs_hpi.png",
    "results/visualizations/top15_metros_hpi.png",
    "results/visualizations/correlation_matrix.png",
]


def find_snakemake():
    beside = Path(sys.executable).parent / "snakemake"
    if beside.exists():
        return beside
    found = shutil.which("snakemake")
    return Path(found) if found else None


# the rules a dry run schedules, read off the "rule <name>:" line it prints for
# each planned job
def planned(output):
    return sorted(set(re.findall(r"^(?:local)?rule (\w+):", output, flags=re.MULTILINE)))


class PlanCase(unittest.TestCase):
    def setUp(self):
        binary = find_snakemake()
        if binary is None:
            self.skipTest("snakemake is not installed for this interpreter")
        self.snakemake = binary
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tree = Path(tmp.name).resolve()
        (self.tree / "Snakefile").write_text(SNAKEFILE.read_text())
        # the pinned vintages are tracked rather than downloaded, so every
        # checkout has them whatever state its archive is in
        census = self.tree / "data" / "raw" / "census"
        census.mkdir(parents=True)
        (census / "vintages.json").write_text(VINTAGES.read_text())

    def lay_out(self, *sources):
        # an hour old, so anything built from it afterwards is plainly newer
        then = time.time() - 3600
        for source in sources:
            folder = self.tree / "data" / "raw" / source
            folder.mkdir(parents=True, exist_ok=True)
            for name, text in ARCHIVE[source].items():
                (folder / name).write_text(text)
                os.utime(folder / name, (then, then))

    # the merged csv and charts a finished run built from that archive
    def lay_out_outputs(self):
        for name in INTEGRATED:
            path = self.tree / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("built from the archive\n")

    def plan(self, *extra):
        command = [
            str(self.snakemake), "--dry-run", "--cores", "1",
            "--snakefile", str(self.tree / "Snakefile"),
            "--directory", str(self.tree),
            *extra,
        ]
        result = subprocess.run(command, cwd=str(self.tree), capture_output=True, text=True, timeout=300)
        return result, result.stdout + result.stderr


class TestTheRecommendedRunReachesTheDownloads(PlanCase):
    # the control, and proof the harness reads a plan at all
    def test_a_forced_run_plans_integrate(self):
        self.lay_out("fhfa", "census")
        result, output = self.plan("--forceall")
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("integrate", planned(output))

    # --forceall plans every job rule all depends on. run_all.py runs both
    # downloads every time, so the recommended command must be able to as well
    def test_a_forced_run_plans_both_downloads(self):
        self.lay_out("fhfa", "census")
        result, output = self.plan("--forceall")
        self.assertEqual(result.returncode, 0, output)
        self.assertEqual([rule for rule in DOWNLOADS if rule not in planned(output)], [],
                         f"the plan is {planned(output)}")

    # a tree whose fhfa archive is gone is the case a download rule exists for.
    # the recommended command plans the download that makes the file, the way
    # run_all.py would fetch it, rather than stopping on a missing input
    def test_a_tree_without_the_fhfa_archive_plans_its_download(self):
        self.lay_out("census")
        result, output = self.plan()
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("download_fhfa", planned(output))


# the other half of the same promise. hpi_master.csv has no vintage parameter,
# so the archived copy is the only copy there is, and a plain run over a whole
# archive plans no download at all. a rule output the collectors never write
# would count as missing on every run and fetch the archive again each time
class TestAWholeArchiveIsLeftAlone(PlanCase):
    def test_a_whole_archive_plans_no_download(self):
        self.lay_out("fhfa", "census")
        result, output = self.plan()
        self.assertEqual(result.returncode, 0, output)
        self.assertEqual([rule for rule in DOWNLOADS if rule in planned(output)], [],
                         f"the plan is {planned(output)}")

    # and once the merged csv and charts are built from it, nothing is left to do
    def test_a_whole_tree_plans_nothing(self):
        self.lay_out("fhfa", "census")
        self.lay_out_outputs()
        result, output = self.plan()
        self.assertEqual(result.returncode, 0, output)
        self.assertEqual(planned(output), [], output)


if __name__ == "__main__":
    unittest.main()

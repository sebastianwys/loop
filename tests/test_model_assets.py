import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

# web/scripts/model-assets.mjs runs as prebuild and compiles the backtest csvs
# under ml/results into web/src/lib/modelNumbers.ts, the leaderboard the model
# page publishes. its own header says why the numbers are generated: a page
# quoting them by hand "would go on publishing the old ones with nobody the
# wiser". a build that cannot find one of the backtest files must not rewrite
# the module as a smaller leaderboard, and must not do it without a word. the
# file that matters most is seqgru.csv, the model that ships.
#
# the script finds ml/results and the module relative to itself, so each case
# copies the real script into a throwaway tree laid out like the repo (web/,
# ml/results/) and runs it from web/ the way `npm run build` does. nothing
# under the real web/ or ml/ is written
REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "web" / "scripts" / "model-assets.mjs"
MODULE = REPO_ROOT / "web" / "src" / "lib" / "modelNumbers.ts"
RESULTS = REPO_ROOT / "ml" / "results"

# the backtest files that carry a test block, one or more models each
BACKTEST_FILES = ["baselines.csv", "seqgru.csv", "windowmlp.csv"]


def models_in(module_text):
    return sorted(set(re.findall(r'model: "([^"]+)"', module_text)))


class GeneratorCase(unittest.TestCase):
    def setUp(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node is not installed")
        if not (RESULTS / "backtest").is_dir():
            self.skipTest("ml/results/backtest is not in this checkout")
        self.node = node

    # a tree laid out like the repo, holding the committed module and
    # ml/results/backtest as a retrain leaves it minus the named files, and the
    # generator run over it
    def build_without(self, *missing):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        # resolved, because the script only runs its main when the path it was
        # started by is the path node resolved it to
        tree = Path(tmp.name).resolve()
        script = tree / "web" / "scripts" / "model-assets.mjs"
        module = tree / "web" / "src" / "lib" / "modelNumbers.ts"
        results = tree / "ml" / "results"
        script.parent.mkdir(parents=True)
        module.parent.mkdir(parents=True)
        (results / "figures").mkdir(parents=True)
        script.write_text(SCRIPT.read_text())
        module.write_text(MODULE.read_text())
        # the generator reads the manifest, the admission tables, the figures'
        # sizes, the shipped forecast and the yearly refit record as well as the
        # backtest, so everything but the files a case removes is copied
        for item in RESULTS.iterdir():
            if item.is_file():
                shutil.copy(item, results / item.name)
        for figure in (RESULTS / "figures").glob("*.png"):
            shutil.copy(figure, results / "figures" / figure.name)
        shutil.copytree(RESULTS / "forecast", results / "forecast")
        shutil.copytree(RESULTS / "walkforward", results / "walkforward")
        shutil.copytree(RESULTS / "backtest", results / "backtest",
                        ignore=lambda _dir, names: [n for n in names if n in missing])

        result = subprocess.run([self.node, str(script)], cwd=str(tree / "web"),
                                capture_output=True, text=True, timeout=120)
        output = (result.stdout + result.stderr).strip()
        # every path through main prints, so silence means main never ran
        self.assertTrue(output, "the generator printed nothing, so its main never ran")
        return result, output, module.read_text()


class TestTheControl(GeneratorCase):
    # with every file in place the run reproduces the committed module byte for
    # byte, so any difference below comes from the file that is missing
    def test_every_backtest_file_present_reproduces_the_committed_module(self):
        result, output, module = self.build_without()
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("[model-assets]", output)
        self.assertEqual(module, MODULE.read_text())


class TestAMissingBacktestFileIsNeverASmallerLeaderboard(GeneratorCase):
    def test_the_module_keeps_every_model_when_a_backtest_file_is_missing(self):
        committed = models_in(MODULE.read_text())
        for name in BACKTEST_FILES:
            with self.subTest(missing=name):
                _, output, module = self.build_without(name)
                self.assertEqual(models_in(module), committed, output)

    def test_the_build_names_the_backtest_file_it_could_not_find(self):
        for name in BACKTEST_FILES:
            with self.subTest(missing=name):
                _, output, _ = self.build_without(name)
                self.assertIn(name, output)


if __name__ == "__main__":
    unittest.main()

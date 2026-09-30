# a red test. run from the project root:
#   ml/.venv/bin/python -m unittest tests/redtest_gazetteer_import.py -v
#
# run_bot promises that a collector module that will not import is one failed
# collector: the others still run and the run exits non-zero. test_run_bot
# checks that with importlib.import_module stood in for, so it never reaches an
# import made at the top of a module, and run_bot imports build_map_data at the
# top, which imports the gazetteer's YEAR at the top. a gazetteer that will not
# import, as a syntax error or a missing dependency in that file would make it,
# stops the run before discover() gives any collector a turn.
#
# the run happens in a fresh interpreter, where a meta path finder breaks
# bot.collectors.gazetteer and nothing else. the two collectors are stand-ins,
# so nothing reaches the network, and the map build is replaced wherever it
# still imports, so nothing is written

import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

RUN = r'''
import importlib.abc
import json
import pkgutil
import sys
import types


class BrokenGazetteer(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name == "bot.collectors.gazetteer":
            raise ImportError("gazetteer will not import")
        return None


sys.meta_path.insert(0, BrokenGazetteer())
ran = []

for name in ("first", "second"):
    module = types.ModuleType(f"bot.collectors.{name}")
    module.collect = lambda name=name: ran.append(name)
    sys.modules[module.__name__] = module

pkgutil.iter_modules = lambda path=None, prefix="": [
    types.SimpleNamespace(name=name) for name in ("first", "gazetteer", "second")]

try:
    import bot.build_map_data
except ImportError:
    pass
else:
    bot.build_map_data.build = lambda *args, **kwargs: ran.append("build")

try:
    import bot.run_bot
    bot.run_bot.main()
finally:
    print(json.dumps(ran))
'''


class TestABrokenGazetteerIsOneFailedCollector(unittest.TestCase):
    def test_the_other_collectors_still_run_and_the_run_fails(self):
        result = subprocess.run([sys.executable, "-c", RUN], cwd=ROOT, capture_output=True, text=True,
                                timeout=300)
        ran = json.loads(result.stdout.strip().splitlines()[-1])
        where = " | ".join(result.stderr.strip().splitlines()[-3:])
        self.assertEqual([name for name in ran if name != "build"], ["first", "second"],
                         f"the run stopped before any collector had a turn: {where}")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("[gazetteer] FAILED to import", result.stdout)


if __name__ == "__main__":
    unittest.main()

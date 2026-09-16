import io
import types
import unittest
from contextlib import redirect_stdout
from unittest import mock

from bot import run_bot

NAMES = ["gazetteer", "acs", "bps", "fred"]


def module_that_collects(recorder, name, failing):
    def collect():
        recorder.append(name)
        if name in failing:
            raise RuntimeError("the api said no")

    return types.SimpleNamespace(collect=collect)


# run_bot's contract is to keep going past a failure and report at the end. an
# import error used to escape discover() before a single collector ran, so one
# broken module lost the whole scheduled run and the map was never rebuilt
class TestOneBrokenCollector(unittest.TestCase):
    def run_main(self, broken=(), failing=()):
        ran, built = [], []

        def iter_modules(path):
            return [types.SimpleNamespace(name=name) for name in NAMES]

        def import_module(dotted):
            name = dotted.rsplit(".", 1)[-1]
            if name in broken:
                raise ImportError(f"cannot import {name}")
            return module_that_collects(ran, name, failing)

        out = io.StringIO()
        with mock.patch.object(run_bot.pkgutil, "iter_modules", iter_modules), \
             mock.patch.object(run_bot.importlib, "import_module", import_module), \
             mock.patch.object(run_bot.build_map_data, "build", lambda: built.append(True)):
            code = 0
            try:
                with redirect_stdout(out):
                    run_bot.main()
            except SystemExit as exit_error:
                code = exit_error.code
        return ran, built, code, out.getvalue()

    def test_a_module_that_will_not_import_does_not_stop_the_others(self):
        ran, built, code, printed = self.run_main(broken={"bps"})
        self.assertEqual(ran, ["gazetteer", "acs", "fred"])
        self.assertEqual(built, [True])
        self.assertNotEqual(code, 0)
        self.assertIn("bps", printed)

    def test_a_broken_gazetteer_still_lets_the_rest_run(self):
        ran, built, code, _ = self.run_main(broken={"gazetteer"})
        self.assertEqual(ran, ["acs", "bps", "fred"])
        self.assertEqual(built, [True])
        self.assertNotEqual(code, 0)

    def test_a_collector_that_raises_is_reported_the_same_way(self):
        ran, built, code, printed = self.run_main(failing={"acs"})
        self.assertEqual(ran, NAMES)
        self.assertEqual(built, [True])
        self.assertNotEqual(code, 0)
        self.assertIn("acs", printed)

    def test_a_clean_run_exits_zero_with_the_gazetteer_first(self):
        ran, built, code, _ = self.run_main()
        self.assertEqual(ran, NAMES)
        self.assertEqual(ran[0], "gazetteer")
        self.assertEqual(built, [True])
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()

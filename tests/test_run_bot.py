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


class RunBotCase(unittest.TestCase):
    def run_main(self, broken=(), failing=(), only=None):
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
                    run_bot.main(only)
            except SystemExit as exit_error:
                code = exit_error.code
        return ran, built, code, out.getvalue()


# run_bot's contract is to keep going past a failure and report at the end. an
# import error used to escape discover() before a single collector ran, so one
# broken module lost the whole scheduled run and the map was never rebuilt
class TestOneBrokenCollector(RunBotCase):
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


# the national strip is fred, which publishes daily, so it refreshes on its own
# schedule rather than waiting for the monthly run over every source
class TestOnlyOneCollector(RunBotCase):
    def test_only_runs_what_it_was_asked_for(self):
        ran, built, code, _ = self.run_main(only=["fred"])
        self.assertEqual(ran, ["fred"])
        self.assertEqual(built, [True])
        self.assertEqual(code, 0)

    def test_only_still_rebuilds_the_map(self):
        ran, built, code, _ = self.run_main(only=["acs", "bps"])
        self.assertEqual(ran, ["acs", "bps"])
        self.assertEqual(built, [True])

    # a module unrelated to the run is not this run's problem
    def test_a_broken_module_outside_the_selection_is_ignored(self):
        ran, built, code, _ = self.run_main(broken={"bps"}, only=["fred"])
        self.assertEqual(ran, ["fred"])
        self.assertEqual(code, 0)

    def test_a_broken_module_inside_the_selection_still_fails(self):
        ran, built, code, _ = self.run_main(broken={"fred"}, only=["fred"])
        self.assertEqual(ran, [])
        self.assertNotEqual(code, 0)

    def test_a_name_that_is_not_a_collector_stops_the_run(self):
        ran, built, code, printed = self.run_main(only=["nowhere"])
        self.assertEqual(ran, [])
        self.assertEqual(built, [])
        self.assertNotEqual(code, 0)


    def test_the_argument_parser_takes_names_after_only(self):
        self.assertIsNone(run_bot.parse_args([]))
        self.assertEqual(run_bot.parse_args(["--only", "national"]), ["national"])
        self.assertEqual(run_bot.parse_args(["--only", "national", "fred"]), ["national", "fred"])
        with self.assertRaises(SystemExit):
            run_bot.parse_args(["--only"])
        with self.assertRaises(SystemExit):
            run_bot.parse_args(["national"])


if __name__ == "__main__":
    unittest.main()

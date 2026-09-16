import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from threadpoolctl import threadpool_limits

from loop import backtest, baselines, charts, spec

try:
    from test_backtest import synthetic_panel
except ImportError:
    from tests.test_backtest import synthetic_panel


# the boosting fits thrash on many threads at this data size
THREADS = 4


class TestBaselines(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel = synthetic_panel()
        cls.data = backtest.dataset(cls.panel)
        with threadpool_limits(limits=THREADS):
            cls.results = {name: baselines.run_model(name, cls.data) for name in baselines.MODELS}
        # the alphas of this run, taken here. the module global holds the last
        # ridge call's horizons and any later call replaces them
        cls.ridge_alphas = dict(baselines.RIDGE_ALPHA)

    def test_every_test_sample_gets_a_finite_median(self):
        for name, (preds, _, _) in self.results.items():
            self.assertEqual(list(preds.columns), backtest.PREDICTION_COLUMNS)
            self.assertEqual(set(preds["model"]), {name})
            for h in spec.HORIZONS:
                expected = (backtest.samples(self.panel, h)["block"] == "test").sum()
                rows = preds[(preds["horizon"] == h) & (preds["block"] == "test")]
                self.assertEqual(len(rows), expected, name)
                self.assertTrue(np.isfinite(rows[["q10", "q50", "q90", "lo", "hi"]]).all().all(), name)

    def test_quantiles_are_ordered(self):
        for name, (preds, _, _) in self.results.items():
            self.assertTrue((preds["q10"] <= preds["q50"]).all(), name)
            self.assertTrue((preds["q50"] <= preds["q90"]).all(), name)
            self.assertTrue((preds["lo"] <= preds["hi"]).all(), name)

    def test_no_change_is_flat_with_train_quantiles(self):
        preds, summary, _ = self.results["no_change"]
        self.assertTrue((preds["q50"] == 0).all())
        self.assertTrue(np.allclose(summary["relative_mae"], 1.0))
        train = self.data[(self.data["horizon"] == 4) & (self.data["block"] == "train")]
        rows = preds[preds["horizon"] == 4]
        self.assertAlmostEqual(rows["q10"].iloc[0], np.quantile(train["y"], 0.1))
        self.assertAlmostEqual(rows["q90"].iloc[0], np.quantile(train["y"], 0.9))

    def test_point_rules_follow_their_feature(self):
        keys = spec.KEY + ["horizon"]
        merged = self.results["momentum"][0].merge(self.data[keys + ["hpi_yoy", "qoq_mean"]], on=keys)
        self.assertTrue(np.allclose(merged["q50"], merged["hpi_yoy"].fillna(0.0) * merged["horizon"] / 4.0))
        merged = self.results["metro_mean"][0].merge(self.data[keys + ["qoq_mean"]], on=keys)
        self.assertTrue(np.allclose(merged["q50"], merged["qoq_mean"].fillna(0.0) * merged["horizon"]))
        width = merged["q90"] - merged["q10"]
        self.assertGreater(width.min(), 0)

    def test_outcomes_outside_train_never_reach_a_model(self):
        data = self.data[self.data["horizon"] == 1].copy()
        outside = (data["block"] != "train").to_numpy()
        data.loc[outside, "y"] = data.loc[outside, "y"].to_numpy()[::-1] + 0.5
        for name, fit in baselines.MODELS.items():
            before = self.results[name][0]
            before = before[before["horizon"] == 1]
            with threadpool_limits(limits=THREADS):
                after = fit(data)
            for col in ("q10", "q50", "q90"):
                self.assertTrue(np.allclose(before[col], after[col]), f"{name} {col}")

    def test_ridge_and_gbm_beat_no_change_on_test(self):
        for name in ("ridge", "gbm"):
            summary = self.results[name][1]
            test = summary[summary["block"] == "test"]
            for h, value in zip(test["horizon"], test["relative_mae"]):
                self.assertLess(value, 1.0, f"{name} at {h} quarters")
        self.assertEqual(sorted(self.ridge_alphas), list(spec.HORIZONS))
        for alpha in baselines.RIDGE_ALPHA.values():
            self.assertIn(alpha, list(baselines.ALPHAS))

    def test_calibration_covers_the_cal_block(self):
        for name, (_, summary, margins) in self.results.items():
            cal = summary[summary["block"] == "cal"]
            self.assertTrue((cal["coverage"] >= 1 - spec.ALPHA).all(), name)
            self.assertEqual(list(margins["horizon"]), list(spec.HORIZONS))
            self.assertTrue(np.isfinite(margins["margin"]).all())

    def test_alpha_search_splits_train_by_time(self):
        train = self.data[(self.data["horizon"] == 4) & (self.data["block"] == "train")]
        seen = []
        real_fit = baselines.Ridge.fit

        def spy(model, X, y):
            seen.append(len(y))
            return real_fit(model, X, y)

        with mock.patch.object(baselines.Ridge, "fit", spy):
            alpha = baselines._pick_alpha(train, 4)
        self.assertIn(alpha, list(baselines.ALPHAS))
        self.assertEqual(len(seen), len(baselines.ALPHAS))
        self.assertLess(seen[0], 0.8 * len(train), "the fit part stops before the cut minus the horizon")


class TestRunAll(unittest.TestCase):
    def test_writes_summaries_predictions_and_figures(self):
        panel = synthetic_panel(metros=14, start="1995Q1")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            patches = (
                mock.patch.object(spec, "BACKTEST_DIR", root / "backtest"),
                mock.patch.object(spec, "ML_ROOT", root),
                mock.patch.object(charts, "FIGURES_DIR", root / "figures"),
            )
            with patches[0], patches[1], patches[2], threadpool_limits(limits=THREADS):
                combined, margins = baselines.run_all(panel, log=lambda *_: None)
            names = list(baselines.MODELS)
            for name in names + ["baselines", "baselines_margins"]:
                self.assertTrue((root / "backtest" / f"{name}.csv").exists(), name)
            for name in names:
                self.assertTrue((root / "data" / f"predictions_{name}.parquet").exists(), name)
            for figure in ("05_backtest_design", "06_baseline_errors", "07_calibration", "08_actual_vs_predicted"):
                self.assertTrue((root / "figures" / f"{figure}.png").exists(), figure)
        self.assertEqual(len(combined), len(names) * len(spec.HORIZONS) * len(backtest.BLOCKS))
        self.assertEqual(list(combined["model"].unique()), names)
        self.assertEqual(len(margins), len(names) * len(spec.HORIZONS))


# the chosen alphas live in a module global that main() prints as this run's.
# a horizon left there by an earlier run was printed as if it had just been
# fitted, which is a lie in the run log the readme quotes
class TestRidgeAlphasAreThisRunsOnly(unittest.TestCase):
    def test_a_stale_horizon_does_not_survive_the_next_fit(self):
        data = backtest.dataset(synthetic_panel(), horizons=(4,))
        baselines.RIDGE_ALPHA[99] = 1.234
        with threadpool_limits(limits=THREADS):
            baselines.run_model("ridge", data)
        self.assertEqual(set(baselines.RIDGE_ALPHA), {4})
        self.assertNotIn(99, baselines.RIDGE_ALPHA)


if __name__ == "__main__":
    unittest.main()

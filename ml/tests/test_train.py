import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

from loop import charts, nets, spec, train


def tiny_panel():
    return train.synthetic_panel(n_metros=6, start="2000Q1")


class TestSplits(unittest.TestCase):
    def test_outcome_quarter_decides_fit_or_val(self):
        self.assertEqual(train.split_of("2014Q3", 1), "fit")
        self.assertEqual(train.split_of("2014Q4", 1), "val")
        self.assertEqual(train.split_of("2013Q4", 8), "val")
        self.assertEqual(train.split_of("2012Q4", 8), "fit")
        self.assertEqual(train.split_of("2017Q3", 1), "val")
        self.assertEqual(train.split_of("2018Q1", 1), "cal")
        self.assertEqual(train.split_of("2022Q1", 8), "test")
        self.assertEqual(train.split_of("2016Q1", 8), "cal")   # outcome 2018Q1

    def test_splits_table_has_one_label_per_horizon(self):
        table = train.splits(np.array(["2014Q3", "2018Q1"], dtype=object))
        self.assertEqual(table.shape, (2, len(spec.HORIZONS)))
        self.assertEqual(list(table[0]), ["fit", "val", "val", "val"])
        self.assertEqual(list(table[1]), ["cal", "cal", "cal", "cal"])


class TestSyntheticPanel(unittest.TestCase):
    def test_contract_columns_and_late_sources(self):
        panel = tiny_panel()
        self.assertEqual(list(panel.columns), spec.PANEL_COLUMNS)
        self.assertEqual(len(panel), 6 * len(pd.period_range("2000Q1", "2026Q2", freq="Q")))
        self.assertTrue(panel.loc[panel.quarter < "2014Q1", "unemp"].isna().all())
        live = panel[(panel.quarter >= "2015Q1") & panel.hpi.notna()]
        self.assertTrue(live.zori.notna().all())
        self.assertTrue(panel.hpi.isna().any())
        self.assertTrue(panel.groupby("cbsa_code").size().eq(len(panel) // 6).all())


class TestFitAndScore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel = tiny_panel()
        cls.predictions, cls.history = train.fit_and_score(cls.panel, "windowmlp", device="cpu", max_epochs=2, verbose=False)

    def test_two_epochs_finish_with_the_expected_frame(self):
        # the shared calibration prepends the model name
        self.assertEqual(list(self.predictions.columns), ["model"] + train.PREDICTION_COLUMNS)
        self.assertEqual(set(self.predictions.block), {"cal", "test"})
        self.assertEqual(list(self.history.columns), ["epoch", "train_loss", "val_loss"])
        self.assertEqual(len(self.history), 2)
        self.assertTrue(self.history.val_loss.notna().all())
        self.assertTrue(self.predictions.y.notna().all())
        self.assertTrue(((self.predictions.q10 <= self.predictions.q50) & (self.predictions.q50 <= self.predictions.q90)).all())
        self.assertFalse(self.predictions.duplicated(["cbsa_code", "quarter", "horizon"]).any())
        # the block is decided by the outcome, so an eight quarter origin can sit
        # before TEST_START while its outcome lands after it
        test = self.predictions[self.predictions.block == "test"]
        outcomes = test.apply(lambda r: str(spec.to_period(r.quarter) + r.horizon), axis=1)
        self.assertTrue((outcomes >= spec.TEST_START).all())
        cal = self.predictions[self.predictions.block == "cal"]
        cal_outcomes = cal.apply(lambda r: str(spec.to_period(r.quarter) + r.horizon), axis=1)
        self.assertTrue((cal_outcomes <= spec.CAL_END).all())
        self.assertTrue((cal_outcomes >= spec.CAL_START).all())

    def test_seed_makes_the_run_repeat(self):
        again, history = train.fit_and_score(self.panel, "windowmlp", device="cpu", max_epochs=2, verbose=False)
        np.testing.assert_allclose(again.q50.to_numpy(), self.predictions.q50.to_numpy(), rtol=0, atol=1e-6)
        np.testing.assert_allclose(history.train_loss.to_numpy(), self.history.train_loss.to_numpy(), rtol=0, atol=1e-9)

    def test_conformal_band_covers_the_cal_block(self):
        cal = self.predictions[self.predictions.block == "cal"]
        for h in spec.HORIZONS:
            g = cal[cal.horizon == h]
            self.assertGreaterEqual(spec.coverage(g.y, g.lo, g.hi), 1 - spec.ALPHA, h)
        margin = train.margins(self.predictions, "cal")
        self.assertEqual(set(margin), set(spec.HORIZONS))
        row = cal.iloc[0]
        self.assertAlmostEqual(row.lo, row.q10 - margin[int(row.horizon)])
        self.assertAlmostEqual(row.hi, row.q90 + margin[int(row.horizon)])

    def test_evaluate_gives_one_row_per_block_and_horizon(self):
        summary = train.evaluate(self.predictions)
        self.assertEqual(len(summary), 2 * len(spec.HORIZONS))
        for column in ("n", "mae", "rmse", "relative_mae", "pinball_10", "pinball_50", "pinball_90", "coverage_raw", "coverage", "width", "mae_pct"):
            self.assertIn(column, summary.columns)
        cal = summary[summary.block == "cal"]
        self.assertTrue((cal.coverage >= 1 - spec.ALPHA).all())
        row = summary.iloc[0]
        g = self.predictions[(self.predictions.block == row.block) & (self.predictions.horizon == row.horizon)]
        self.assertAlmostEqual(row.mae_pct, np.mean(np.abs(spec.pct(g.y) - spec.pct(g.q50))))
        self.assertEqual(train.best_epoch(self.history), int(self.history.loc[self.history.val_loss.idxmin(), "epoch"]))


class TestForecast(unittest.TestCase):
    def test_one_row_per_metro_and_horizon_with_an_ordered_band(self):
        panel = tiny_panel()
        frame = train.forecast(panel, "seqgru", epochs=1, device="cpu", verbose=False)
        self.assertEqual(list(frame.columns), ["cbsa_code", "origin", "horizon", "q10", "q50", "q90", "lo", "hi", "q50_pct", "lo_pct", "hi_pct", "model"])
        self.assertEqual(len(frame), panel.cbsa_code.nunique() * len(spec.HORIZONS))
        self.assertTrue(frame.groupby("cbsa_code").horizon.apply(lambda s: sorted(s) == list(spec.HORIZONS)).all())
        self.assertTrue(((frame.lo <= frame.q50) & (frame.q50 <= frame.hi)).all())
        self.assertEqual(set(frame.origin), {"2026Q2"})
        self.assertEqual(set(frame.model), {"seqgru"})
        np.testing.assert_allclose(frame.q50_pct, spec.pct(frame.q50))


# the shipped band comes from the second model's margin on the test block. a
# horizon with nothing realized there has no margin, and the map contract wants
# a band around every point it draws
# the whole evaluation rests on the models never seeing a calibration or test
# outcome while they fit. nothing failed when they did, so this reads the arrays
# the fitting function is actually handed
class TestNoOutcomeLeaksIntoFitting(unittest.TestCase):
    def spy(self):
        calls = []
        real = train.train_one

        def recorder(model_name, windows, y_fit, y_val=None, *args, **kwargs):
            calls.append({
                "y_fit": np.array(y_fit, dtype=float),
                "y_val": None if y_val is None else np.array(y_val, dtype=float),
            })
            return real(model_name, windows, y_fit, y_val, *args, **kwargs)

        return calls, recorder

    def test_the_backtest_is_handed_fit_and_val_outcomes_only(self):
        panel = tiny_panel()
        calls, recorder = self.spy()
        with mock.patch.object(train, "train_one", recorder):
            train.fit_and_score(panel, "windowmlp", device="cpu", max_epochs=1, verbose=False)
        self.assertEqual(len(calls), 1)
        table = train.splits(nets.build_windows(panel).origins)
        y_fit, y_val = calls[0]["y_fit"], calls[0]["y_val"]
        self.assertTrue((table[~np.isnan(y_fit)] == "fit").all())
        self.assertTrue((table[~np.isnan(y_val)] == "val").all())
        later = np.isin(table, ["cal", "test"])
        self.assertTrue(np.isnan(y_fit[later]).all())
        self.assertTrue(np.isnan(y_val[later]).all())
        self.assertTrue((~np.isnan(y_fit)).any())
        self.assertTrue((~np.isnan(y_val)).any())

    # the second model sets the band width, so it must stop at the calibration
    # end or the margin is measured on outcomes it was fitted on
    def test_the_band_model_is_handed_nothing_past_the_calibration_end(self):
        panel = tiny_panel()
        calls, recorder = self.spy()
        with mock.patch.object(train, "train_one", recorder):
            train.forecast_models(panel, "windowmlp", epochs=1, device="cpu", verbose=False)
        self.assertEqual(len(calls), 2)
        windows = nets.build_windows(panel)
        outcome = windows.t[:, None] + np.asarray(spec.HORIZONS)[None, :]
        cal_end = windows.index_of(spec.CAL_END)
        band_y = calls[1]["y_fit"]
        self.assertTrue((outcome[~np.isnan(band_y)] <= cal_end).all())
        self.assertTrue(np.isnan(band_y[outcome > cal_end]).all())
        self.assertTrue((~np.isnan(band_y)).any())

    def test_the_shipped_margin_is_the_band_model_on_the_test_block(self):
        panel = tiny_panel()
        frame, final, second, _ = train.forecast_models(panel, "windowmlp", epochs=1, device="cpu", verbose=False)
        windows = nets.build_windows(panel)
        table = train.splits(windows.origins)
        scored = (table == "test") & ~np.isnan(windows.y)
        idx = np.nonzero(scored.any(axis=1))[0]

        def margin_of(fitted):
            pred = train.predict(fitted["model"], fitted["inputs"], idx, fitted["device"])
            return train.margins(train.predictions_frame(windows, table, pred, idx), "test")

        held_out = margin_of(second)
        for horizon, group in frame.groupby("horizon"):
            width = (group.q10 - group.lo).to_numpy()
            np.testing.assert_allclose(width, held_out[int(horizon)], rtol=0, atol=1e-9)
            np.testing.assert_allclose((group.hi - group.q90).to_numpy(), held_out[int(horizon)], rtol=0, atol=1e-9)
        # the final model has fitted those same outcomes, so its margin on them
        # is a different, narrower number. the band must not come from there
        in_sample = margin_of(final)
        self.assertNotAlmostEqual(held_out[1], in_sample[1], places=6)


class TestBandNeedsAConformalSample(unittest.TestCase):
    def test_a_panel_with_no_test_outcome_refuses_to_forecast(self):
        panel = train.synthetic_panel(n_metros=6, start="2000Q1", end="2021Q4")
        with self.assertRaises(ValueError) as raised:
            train.forecast(panel, "seqgru", epochs=1, device="cpu", verbose=False)
        self.assertIn("horizon", str(raised.exception))

    def test_a_full_panel_still_bands_every_horizon(self):
        frame = train.forecast(tiny_panel(), "seqgru", epochs=1, device="cpu", verbose=False)
        self.assertTrue(frame.lo.notna().all())
        self.assertTrue(frame.hi.notna().all())


class TestRun(unittest.TestCase):
    def test_run_writes_every_artifact(self):
        panel = tiny_panel()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            patches = [
                mock.patch.object(spec, "ML_ROOT", root),
                mock.patch.object(spec, "BACKTEST_DIR", root / "backtest"),
                mock.patch.object(spec, "FORECAST_DIR", root / "forecast"),
                mock.patch.object(spec, "MODELS_DIR", root / "models"),
                mock.patch.object(charts, "FIGURES_DIR", root / "figures"),
            ]
            for p in patches:
                p.start()
            try:
                out = train.run(panel=panel, device="cpu", max_epochs=2, verbose=False)
            finally:
                for p in patches:
                    p.stop()
            self.assertIn(out["shipped"], train.MODELS)
            for name in train.MODELS:
                self.assertTrue((root / "data" / f"predictions_{name}.parquet").exists())
                self.assertTrue((root / "backtest" / f"{name}.csv").exists())
                self.assertTrue((root / "backtest" / f"{name}_history.csv").exists())
                self.assertTrue((root / "forecast" / f"forecasts_{name}.csv").exists())
                self.assertTrue((root / "models" / f"{name}.pt").exists())
            shipped = pd.read_csv(root / "forecast" / "forecasts.csv", dtype={"cbsa_code": str})
            self.assertEqual(set(shipped.model), {out["shipped"]})
            for name in ("09_training_curves", "10_quantile_calibration", "11_forecast_fans", "12_model_comparison", "13_forecast_distribution"):
                self.assertGreater(os.path.getsize(root / "figures" / f"{name}.png"), 1000)


class TestShippedSelectionIgnoresTheTestBlock(unittest.TestCase):
    # the cal block always picks windowmlp. the test block picks whichever model
    # the fixture hands the low test error to. selection may read cal rows only
    CAL_MAE_PCT = {"windowmlp": 3.965160196951248, "seqgru": 8.773784637313579}
    GOOD_TEST_MAE_PCT = 3.2250869830566873
    BAD_TEST_MAE_PCT = 6.95688158091336

    def run_with(self, test_favourite):
        panel = tiny_panel()
        real_evaluate = train.shared.evaluate

        def evaluate(predictions, *args, **kwargs):
            summary = real_evaluate(predictions, *args, **kwargs)
            name = str(predictions["model"].iloc[0])
            at_four = summary["horizon"] == 4
            summary.loc[at_four & (summary["block"] == "cal"), "mae_pct"] = self.CAL_MAE_PCT[name]
            test_value = self.GOOD_TEST_MAE_PCT if name == test_favourite else self.BAD_TEST_MAE_PCT
            summary.loc[at_four & (summary["block"] == "test"), "mae_pct"] = test_value
            return summary

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            patches = [
                mock.patch.object(spec, "ML_ROOT", root),
                mock.patch.object(spec, "BACKTEST_DIR", root / "backtest"),
                mock.patch.object(spec, "FORECAST_DIR", root / "forecast"),
                mock.patch.object(spec, "MODELS_DIR", root / "models"),
                mock.patch.object(charts, "FIGURES_DIR", root / "figures"),
                mock.patch.object(train.shared, "evaluate", evaluate),
            ]
            for p in patches:
                p.start()
            try:
                out = train.run(panel=panel, device="cpu", max_epochs=2, verbose=False)
            finally:
                for p in patches:
                    p.stop()
        return out

    def test_shipped_model_is_the_calibration_winner_whatever_the_test_block_says(self):
        favours_seqgru = self.run_with("seqgru")
        favours_windowmlp = self.run_with("windowmlp")
        # the fixture really does put the two blocks in disagreement
        for out, favourite in ((favours_seqgru, "seqgru"), (favours_windowmlp, "windowmlp")):
            summaries = {n: out["results"][n]["summary"] for n in train.MODELS}
            cal = {n: float(s[(s.block == "cal") & (s.horizon == 4)].mae_pct.iloc[0]) for n, s in summaries.items()}
            test = {n: float(s[(s.block == "test") & (s.horizon == 4)].mae_pct.iloc[0]) for n, s in summaries.items()}
            self.assertEqual(cal, self.CAL_MAE_PCT)
            self.assertEqual(min(test, key=test.get), favourite)
        # same cal rows, so the same shipped model, whatever the test rows say
        self.assertEqual(favours_seqgru["shipped"], favours_windowmlp["shipped"])
        self.assertEqual(favours_seqgru["shipped"], "windowmlp")


if __name__ == "__main__":
    unittest.main()

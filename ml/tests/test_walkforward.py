import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

from loop import backtest, baselines, nets, spec, train, walkforward as wf
from tests.test_backtest import synthetic_panel


def outcome_ordinal(frame):
    return wf.ordinals(frame["quarter"]) + frame["horizon"].to_numpy()


# a refit for year Y may learn from what was realized by the end of Y - 1 and
# nothing later, and forecasts only the origins inside Y
class TestAYearSeesOnlyItsPast(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel = synthetic_panel(metros=12)
        cls.view = spec.realtime(cls.panel)
        cls.data = backtest.dataset(cls.view)

    def test_a_classical_model_is_fitted_on_realized_outcomes_only(self):
        seen = {}
        real = baselines.MODELS["ridge"]

        def spy(sub):
            seen["sub"] = sub.copy()
            return real(sub)

        with mock.patch.dict(baselines.MODELS, {"ridge": spy}):
            out = wf.classical_year(self.data, "ridge", 2015)
        fitted = seen["sub"][seen["sub"]["block"] == "train"]
        self.assertLessEqual(outcome_ordinal(fitted).max(), wf.cutoff(2015).ordinal)
        self.assertEqual(set(pd.PeriodIndex(out["quarter"], freq="Q").year), {2015})
        self.assertTrue(out["y"].notna().all())

    def test_a_network_picks_epochs_before_the_cutoff_and_refits_up_to_it(self):
        windows = nets.build_windows(self.view)
        calls = []
        real = train.train_one

        def spy(name, win, y_fit, y_val=None, *args, **kwargs):
            calls.append((np.asarray(y_fit), None if y_val is None else np.asarray(y_val)))
            return real(name, win, y_fit, y_val, *args, **{**kwargs, "max_epochs": 2})

        with mock.patch.object(train, "train_one", spy):
            out, _ = wf.network_year(windows, "seqgru", 2015, device="cpu")
        outcome = windows.t[:, None] + np.asarray(spec.HORIZONS)[None, :]
        end = windows.index_of(str(wf.cutoff(2015)))
        (fit, val), (final, none) = calls
        self.assertIsNone(none)
        self.assertLess(outcome[~np.isnan(fit)].max(), end - 4 * wf.VAL_YEARS + 1)
        self.assertEqual(outcome[~np.isnan(val)].max(), end)
        self.assertEqual(outcome[~np.isnan(final)].max(), end)
        self.assertEqual(set(pd.PeriodIndex(out["quarter"], freq="Q").year), {2015})


class TestTheRecord(unittest.TestCase):
    def frame(self, q50, name):
        return pd.DataFrame({"model": name, "cbsa_code": "10000", "quarter": ["2019Q1", "2019Q2"], "horizon": 1,
                             "block": "cal", "y": [0.01, 0.02], "q10": [q50 - 0.02] * 2, "q50": [q50] * 2,
                             "q90": [q50 + 0.02] * 2, "lo": np.nan, "hi": np.nan})

    def test_the_ensemble_averages_the_two_models_quantile_by_quantile(self):
        out = wf.ensemble(self.frame(0.01, "seqgru"), self.frame(0.03, "ridge"))
        self.assertEqual(set(out["model"]), {"ensemble"})
        np.testing.assert_allclose(out["q50"], 0.02)
        np.testing.assert_allclose(out["q10"], 0.0, atol=1e-12)

    def test_a_window_is_read_by_outcome_quarter(self):
        frame = self.frame(0.01, "seqgru").assign(horizon=[8, 1])
        self.assertEqual(list(wf.within(frame, ("2020Q1", None))["horizon"]), [8])

    # a year already on disk is read back, not refitted
    def test_a_stopped_run_resumes_from_the_years_it_wrote(self):
        panel = synthetic_panel(metros=6)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(wf, "CACHE_DIR", root / "cache"), mock.patch.object(spec, "ML_ROOT", root):
                (root / "data").mkdir()
                first = wf.run_model("no_change", panel, log=lambda *_: None)
                with mock.patch.object(wf, "classical_year", side_effect=AssertionError("refitted")):
                    again = wf.run_model("no_change", panel, log=lambda *_: None)
        pd.testing.assert_frame_equal(first, again)
        self.assertEqual(sorted(set(pd.PeriodIndex(first["quarter"], freq="Q").year)),
                         wf.years(panel["quarter"].max())[: len(set(pd.PeriodIndex(first["quarter"], freq="Q").year))])


# one model's one quarter forecasts for a few metros, origins 2010 to 2023
def band_frame(seed=0, name="seqgru", metros=4):
    rng = np.random.default_rng(seed)
    quarters = [str(q) for q in pd.period_range("2010Q1", "2023Q4", freq="Q")]
    rows = pd.DataFrame([(f"1{m:04d}", q) for q in quarters for m in range(metros)], columns=["cbsa_code", "quarter"])
    q50 = rng.normal(0.01, 0.01, len(rows))
    frame = rows.assign(model=name, horizon=1, y=q50 + rng.normal(0.0, 0.02, len(rows)), q10=q50 - 0.02, q50=q50,
                        q90=q50 + 0.02, lo=np.nan, hi=np.nan)
    return wf.with_blocks(frame)[backtest.PREDICTION_COLUMNS]


def volatility(frame, seed=0):
    keys = pd.MultiIndex.from_frame(frame[["cbsa_code", "quarter"]].astype(str))
    return pd.Series(np.random.default_rng(seed).uniform(0.005, 0.02, len(frame)), index=keys)


# anything realized after 2017 is scaled up and shifted, far enough to move
# any score that read it
def shaken(frame, rows):
    out = frame.copy()
    out.loc[rows, "y"] = out.loc[rows, "y"] * 10 + 0.3
    return out


class TestTheBands(unittest.TestCase):
    def test_the_band_settings_are_chosen_on_tune_outcomes_alone(self):
        frame = band_frame()
        scale = volatility(frame)
        first = wf.choose_band(frame, scale)
        later = outcome_ordinal(frame) > spec.to_period(wf.TUNE[1]).ordinal
        second = wf.choose_band(shaken(frame, later), scale)
        self.assertEqual(first[:4], second[:4])
        # the later bands did read the shaken outcomes, so the check has teeth
        self.assertFalse(np.allclose(first[4].loc[later, "hi"], second[4].loc[later, "hi"]))

    def test_the_static_band_reads_the_calibration_block_alone(self):
        frame = band_frame()
        before = wf.static_band(frame)
        after = wf.static_band(shaken(frame, frame["block"] != "cal"))
        np.testing.assert_allclose(after["lo"], before["lo"])
        np.testing.assert_allclose(after["hi"], before["hi"])
        moved = wf.static_band(shaken(frame, frame["block"] == "cal"))
        self.assertFalse(np.allclose(moved["hi"], before["hi"]))

    def test_the_record_scores_the_static_band_on_test_only_and_pairs_the_gru_with_every_model(self):
        frames = {name: band_frame(seed, name) for seed, name in enumerate(["seqgru", "ridge", "no_change"])}
        with mock.patch.object(wf, "load", side_effect=lambda name, variant="latest": frames[name]), \
                mock.patch.object(backtest, "load_panel", return_value=None), \
                mock.patch.object(backtest, "trailing_volatility", return_value=volatility(frames["seqgru"])):
            out = wf.evaluate(names=list(frames), write=False)
        summary = out["summary"]
        self.assertEqual(set(summary.loc[summary["band"] == "static", "span"]), {wf.TEST[0]})
        self.assertEqual(set(summary.loc[summary["band"] == "online", "span"]), {wf.RECORD[0], wf.TEST[0]})
        self.assertEqual(set(out["bands"]["model"]), {"seqgru", "ridge", "no_change", "ensemble"})
        self.assertEqual(set(out["paired"]["against"]), {"ridge", "no_change", "ensemble"})
        self.assertEqual(set(out["paired"]["span"]), {wf.RECORD[0], wf.TEST[0]})


if __name__ == "__main__":
    unittest.main()

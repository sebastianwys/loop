import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

from loop import backtest, spec


def _ar1(rng, n, phi, scale):
    out = np.zeros(n)
    shocks = rng.normal(0.0, scale, n)
    for t in range(1, n):
        out[t] = phi * out[t - 1] + shocks[t]
    return out


def _yoy(series):
    return np.log(series) - np.log(series.shift(4))


# a panel with the real column contract: random walk log prices sharing a
# national cycle, a metro drift and a persistent metro state that the
# covariates observe with noise, so the inputs at an origin carry signal
# about later growth. sources start in the years the real ones do
def synthetic_panel(metros=36, start="1975Q1", end="2026Q2", seed=spec.SEED):
    rng = np.random.default_rng(seed)
    periods = pd.period_range(start, end, freq="Q")
    quarters = np.array([str(p) for p in periods])
    years = pd.Series(periods.year)
    n = len(periods)
    codes = list(spec.SHOWCASE) + [str(90000 + i) for i in range(metros - len(spec.SHOWCASE))]
    cycle = _ar1(rng, n, 0.8, 0.0025)
    mortgage = 7.5 + 3.0 * np.sin(np.arange(n) / 25.0) + rng.normal(0.0, 0.15, n)
    parts = []
    for i, code in enumerate(codes):
        drift = rng.normal(0.008, 0.002)
        state = _ar1(rng, n, 0.92, 0.004)
        growth = drift + cycle + np.roll(state, 1) + rng.normal(0.0, 0.008, n)
        growth[0] = 0.0
        log_hpi = pd.Series(np.log(100.0) + np.cumsum(growth))
        if i % 6 == 5:
            log_hpi[years < 1990] = np.nan
        annual = pd.Series(state).groupby(years).transform("mean").to_numpy()
        hpi = np.exp(log_hpi)
        zhvi = pd.Series(np.where(years >= 2000, hpi * 2500.0 * np.exp(rng.normal(0.0, 0.01, n)), np.nan))
        zori = pd.Series(np.where(years >= 2015, 1200.0 * np.exp(0.5 * (log_hpi - log_hpi.iloc[-1]) + rng.normal(0.0, 0.01, n)), np.nan))
        frame = pd.DataFrame({
            "cbsa_code": code,
            "quarter": quarters,
            "name": f"metro {code}",
            "level": "msa",
            "parent_cbsa": None,
            "date": periods.end_time.normalize(),
            "hpi": hpi,
            "log_hpi": log_hpi,
            "unemp": np.where(years >= 2014, 5.0 - 30.0 * state + rng.normal(0.0, 0.3, n), np.nan),
            "mortgage": mortgage,
            "zhvi": zhvi,
            "zori": zori,
            "hpi_qoq": log_hpi.diff(),
            "hpi_yoy": log_hpi - log_hpi.shift(4),
            "zhvi_yoy": _yoy(zhvi),
            "zori_yoy": _yoy(zori),
            "permits_per_1000": np.where(years >= 2014, 3.0 + 40.0 * annual + rng.normal(0.0, 0.3, n), np.nan),
            "pop_growth": np.where(years >= 2014, 0.5 + 30.0 * annual + rng.normal(0.0, 0.2, n), np.nan),
            "domestic_migration_rate": np.where(years >= 2014, 20.0 * annual + rng.normal(0.0, 0.2, n), np.nan),
            "income_growth": np.where(years >= 2014, 2.0 + 20.0 * annual + rng.normal(0.0, 0.3, n), np.nan),
            "listing_price_yoy": np.where(years >= 2017, 0.5 * state + rng.normal(0.0, 0.01, n), np.nan),
            "inventory_yoy": np.where(years >= 2017, -3.0 * state + rng.normal(0.0, 0.05, n), np.nan),
        })
        parts.append(frame)
    panel = pd.concat(parts, ignore_index=True)
    return panel[spec.PANEL_COLUMNS]


def _lookup(panel, code, quarter, column):
    row = panel[(panel["cbsa_code"] == code) & (panel["quarter"] == quarter)]
    return row[column].iloc[0]


class TestSyntheticPanel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel = synthetic_panel()

    def test_matches_the_panel_contract(self):
        self.assertEqual(list(self.panel.columns), spec.PANEL_COLUMNS)
        self.assertEqual(self.panel.groupby("cbsa_code").size().nunique(), 1)
        self.assertTrue(self.panel[self.panel["quarter"] < "2014Q1"]["unemp"].isna().all())
        self.assertTrue(self.panel[self.panel["quarter"] >= "2016Q1"]["zori_yoy"].notna().all())


class TestSamples(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel = synthetic_panel()

    def test_outcome_is_growth_to_the_right_quarter(self):
        s = backtest.samples(self.panel, 4)
        row = s[(s["cbsa_code"] == "12420") & (s["quarter"] == "2010Q1")]
        self.assertEqual(len(row), 1)
        expected = _lookup(self.panel, "12420", "2011Q1", "log_hpi") - _lookup(self.panel, "12420", "2010Q1", "log_hpi")
        self.assertAlmostEqual(row["y"].iloc[0], expected)
        self.assertEqual(list(s.columns), backtest.SAMPLE_COLUMNS)
        self.assertTrue((s["horizon"] == 4).all())

    # only an outcome the panel never realizes is dropped. the origins that used
    # to go with them were dropped because block() read the origin and left them
    # between two blocks, which is the defect this suite now pins against
    def test_open_outcomes_are_dropped(self):
        s = backtest.samples(self.panel, 8)
        origins = set(s["quarter"])
        for beyond in ("2024Q3", "2026Q2"):
            self.assertNotIn(beyond, origins, "its outcome is past the panel")
        self.assertIn("2015Q4", origins)
        self.assertIn("2018Q1", origins)
        self.assertIn("2024Q2", origins)

    def test_an_outcome_that_crosses_a_boundary_is_kept(self):
        s = backtest.samples(self.panel, 8)
        origins = set(s["quarter"])
        for kept in ("2016Q1", "2017Q4", "2020Q1", "2021Q4"):
            self.assertIn(kept, origins, "its outcome is realized, so it is a sample")
        late = s[s["cbsa_code"] == list(spec.SHOWCASE)[5]]
        self.assertEqual(late["quarter"].min(), "1990Q1", "a metro whose prices start in 1990 gets no earlier origin")
        self.assertEqual(s["quarter"].min(), "1975Q1")

    def test_block_matches_spec(self):
        for h in spec.HORIZONS:
            s = backtest.samples(self.panel, h)
            expected = s["quarter"].map(lambda q: spec.block(q, h))
            self.assertTrue((s["block"] == expected).all())
            self.assertEqual(set(s["block"]), set(backtest.BLOCKS))
            self.assertTrue(np.isfinite(s["y"]).all())


class TestFeatures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel = synthetic_panel()
        cls.features = backtest.features_at_origin(cls.panel)

    def test_columns_and_shape(self):
        self.assertEqual(list(self.features.columns), spec.KEY + backtest.FEATURE_COLUMNS)
        self.assertEqual(len(self.features), len(self.panel))

    def test_lags_look_backward(self):
        for lag, quarter in ((0, "2012Q3"), (3, "2011Q4"), (7, "2010Q4")):
            got = _lookup(self.features, "38060", "2012Q3", f"lag{lag}")
            self.assertAlmostEqual(got, _lookup(self.panel, "38060", quarter, "hpi_qoq"))

    def test_expanding_mean_and_national_pulse(self):
        metro = self.panel[(self.panel["cbsa_code"] == "38060") & (self.panel["quarter"] <= "2012Q3")]
        self.assertAlmostEqual(_lookup(self.features, "38060", "2012Q3", "qoq_mean"), metro["hpi_qoq"].mean())
        pulse = self.panel[self.panel["quarter"] == "2012Q3"]["hpi_yoy"].mean()
        self.assertAlmostEqual(_lookup(self.features, "38060", "2012Q3", "national_yoy"), pulse)
        for col in spec.FEATURES:
            self.assertAlmostEqual(_lookup(self.features, "38060", "2019Q2", col), _lookup(self.panel, "38060", "2019Q2", col))

    def test_a_missing_quarter_breaks_the_lag(self):
        panel = self.panel[~((self.panel["cbsa_code"] == "38060") & (self.panel["quarter"] == "2012Q1"))]
        features = backtest.features_at_origin(panel)
        self.assertTrue(np.isnan(_lookup(features, "38060", "2012Q3", "lag2")))
        self.assertFalse(np.isnan(_lookup(features, "38060", "2012Q3", "lag1")))

    def test_leakage_check_passes_and_catches_a_future_column(self):
        backtest.assert_no_leakage(self.panel, self.features, 4, n=4)

        def leaky(panel):
            out = backtest.features_at_origin(panel)
            ahead = panel.sort_values(spec.KEY).groupby("cbsa_code")["log_hpi"].shift(-1).to_numpy()
            out["next_growth"] = ahead - panel.sort_values(spec.KEY)["log_hpi"].to_numpy()
            return out

        with self.assertRaises(AssertionError):
            backtest.assert_no_leakage(self.panel, leaky(self.panel), 4, builder=leaky, n=3)

    def test_dataset_joins_every_sample(self):
        data = backtest.dataset(self.panel, horizons=(1, 4))
        n = len(backtest.samples(self.panel, 1)) + len(backtest.samples(self.panel, 4))
        self.assertEqual(len(data), n)
        for col in backtest.SAMPLE_COLUMNS + backtest.FEATURE_COLUMNS:
            self.assertIn(col, data.columns)
        settled = data[(data["quarter"] >= "1977Q1") & (data["cbsa_code"] == "12420")]
        self.assertTrue(settled[["lag0", "lag7", "qoq_mean", "national_yoy"]].notna().all().all())
        late = data[(data["cbsa_code"] == list(spec.SHOWCASE)[5]) & (data["quarter"] == "1990Q2")]
        self.assertTrue(late["lag0"].notna().all() and late["lag1"].isna().all(), "a late start gives null deeper lags")
        first = data[(data["quarter"] == "1975Q1") & (data["horizon"] == 1)]
        self.assertTrue(first["lag0"].isna().all(), "no growth rate exists at the first quarter")


def _no_change_predictions(panel, half_width=0.001):
    parts = []
    for h in spec.HORIZONS:
        s = backtest.samples(panel, h)
        s["q50"] = 0.0
        s["q10"] = -half_width
        s["q90"] = half_width
        parts.append(s)
    frame = pd.concat(parts, ignore_index=True)
    frame["lo"] = frame["q10"]
    frame["hi"] = frame["q90"]
    frame["model"] = "flat"
    return frame


class TestEvaluate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel = synthetic_panel()
        cls.predictions = _no_change_predictions(cls.panel, half_width=0.05)

    def test_rows_and_columns(self):
        summary = backtest.evaluate(self.predictions)
        self.assertEqual(list(summary.columns), backtest.SUMMARY_COLUMNS)
        self.assertEqual(len(summary), len(spec.HORIZONS) * len(backtest.BLOCKS))
        self.assertEqual(list(summary["block"][:3]), list(backtest.BLOCKS))
        self.assertEqual(summary["n"].sum(), len(self.predictions))
        self.assertTrue(np.isfinite(summary.drop(columns=["model", "block"])).all().all())

    def test_relative_mae_of_no_change_is_one(self):
        summary = backtest.evaluate(self.predictions)
        train = summary[summary["block"] == "train"]
        for value in train["relative_mae"]:
            self.assertAlmostEqual(value, 1.0)
        self.assertTrue((train["mae"] == train["pinball_50"] * 2).all())

    def test_mae_pct_is_in_percentage_points(self):
        summary = backtest.evaluate(self.predictions)
        row = summary[(summary["horizon"] == 4) & (summary["block"] == "test")].iloc[0]
        y = self.predictions[(self.predictions["horizon"] == 4) & (self.predictions["block"] == "test")]["y"]
        self.assertAlmostEqual(row["mae_pct"], np.mean(np.abs(spec.pct(y))))
        self.assertGreater(row["mae_pct"], row["mae"])

    def test_model_name_argument(self):
        frame = self.predictions.drop(columns=["model"])
        with self.assertRaises(ValueError):
            backtest.evaluate(frame)
        summary = backtest.evaluate(frame, model="named")
        self.assertEqual(set(summary["model"]), {"named"})


class TestCalibrate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel = synthetic_panel()

    def test_cal_coverage_reaches_nominal(self):
        narrow = _no_change_predictions(self.panel, half_width=0.001)
        before = backtest.evaluate(narrow)
        after, margins = backtest.calibrate(narrow)
        summary = backtest.evaluate(after)
        for h in spec.HORIZONS:
            raw = before[(before["horizon"] == h) & (before["block"] == "cal")]["coverage"].iloc[0]
            cal = summary[(summary["horizon"] == h) & (summary["block"] == "cal")]["coverage"].iloc[0]
            self.assertLess(raw, 0.5)
            self.assertGreaterEqual(cal, 1 - spec.ALPHA)
        self.assertEqual(list(margins.columns), ["model", "horizon", "n_cal", "margin"])
        self.assertEqual(list(margins["horizon"]), list(spec.HORIZONS))
        self.assertTrue((margins["margin"] > 0).all())
        self.assertEqual(list(after.columns), backtest.PREDICTION_COLUMNS)

    def test_margin_applies_to_every_block(self):
        narrow = _no_change_predictions(self.panel, half_width=0.001)
        after, margins = backtest.calibrate(narrow)
        m = margins.set_index("horizon")["margin"]
        for h in spec.HORIZONS:
            rows = after[after["horizon"] == h]
            self.assertTrue(np.allclose(rows["lo"], rows["q10"] - m[h]))
            self.assertTrue(np.allclose(rows["hi"], rows["q90"] + m[h]))
            self.assertEqual(set(rows["block"]), set(backtest.BLOCKS))

    def test_wide_band_shrinks(self):
        wide = _no_change_predictions(self.panel, half_width=1.0)
        after, margins = backtest.calibrate(wide)
        self.assertTrue((margins["margin"] < 0).all())
        self.assertTrue((after["lo"] > after["q10"]).all())


class TestHelpers(unittest.TestCase):
    def test_sort_quantiles(self):
        frame = pd.DataFrame({"q10": [0.3, 0.0], "q50": [0.1, 0.1], "q90": [0.2, 0.2]})
        out = backtest.sort_quantiles(frame)
        self.assertEqual(list(out.iloc[0]), [0.1, 0.2, 0.3])
        self.assertEqual(list(out.iloc[1]), [0.0, 0.1, 0.2])
        self.assertEqual(list(frame.iloc[0]), [0.3, 0.1, 0.2])

    def test_writers_use_the_spec_folders(self):
        frame = pd.DataFrame({"model": ["a"], "horizon": [1], "q50": [0.0]})
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(spec, "BACKTEST_DIR", root / "backtest"), mock.patch.object(spec, "ML_ROOT", root):
                summary = backtest.write_summary(frame, "check")
                predictions = backtest.write_predictions(frame, "check")
            self.assertEqual(summary, root / "backtest" / "check.csv")
            self.assertEqual(predictions, root / "data" / "predictions_check.parquet")
            self.assertEqual(len(pd.read_parquet(predictions)), 1)


# the check picks min(n, len(pool)) samples, so an empty pool means the loop
# body never runs and the assertion passes having compared nothing
class TestLeakageCheckCannotPassVacuously(unittest.TestCase):
    def test_no_samples_is_an_error_not_a_pass(self):
        panel = synthetic_panel().head(0)
        features = backtest.features_at_origin(synthetic_panel())
        with self.assertRaises(AssertionError) as raised:
            backtest.assert_no_leakage(panel, features, 4)
        self.assertIn("no samples", str(raised.exception))


if __name__ == "__main__":
    unittest.main()

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

    # the national columns are one number per quarter shared by every metro,
    # which is what makes them useless to a model and worth having in a fixture
    short_rate = 4.0 + 2.5 * np.sin(np.arange(n) / 19.0)
    national = {
        "cpi_yoy": 0.03 + 0.02 * np.sin(np.arange(n) / 31.0),
        "treasury_10y": mortgage - 1.6,
        "term_spread": mortgage - 1.6 - short_rate,
        "natl_unemp": 6.0 + 2.0 * np.sin(np.arange(n) / 23.0),
        "quarter_sin": np.sin(2.0 * np.pi * periods.quarter / 4.0),
        "quarter_cos": np.cos(2.0 * np.pi * periods.quarter / 4.0),
    }
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
            **national,
        })

        # fhfa's expanded index is a second estimate of the same quarter from
        # 1991, and its standard error is larger for a metro with fewer sales,
        # so a later code carries a looser measurement here
        expanded = pd.Series(np.where(years >= 1991, hpi * np.exp(rng.normal(0.0, 0.004, n)), np.nan))
        frame["hpi_exp"] = expanded
        frame["hpi_exp_yoy"] = _yoy(expanded)
        error = np.where(years >= 1991, 0.3 + 0.12 * i + rng.normal(0.0, 0.05, n), np.nan)
        frame["hpi_rstderr"] = np.abs(error)

        parts.append(frame)
    panel = pd.concat(parts, ignore_index=True)

    # the cross section column has to be built after the metros are together,
    # it is the metro against the median of every other metro that quarter
    panel["hpi_yoy_rel"] = panel["hpi_yoy"] - panel.groupby("quarter")["hpi_yoy"].transform("median")

    # a column added to the contract and not to this fixture makes every test
    # that reads a synthetic panel die on a bare KeyError, several files away
    # from the one that changed. say which column instead
    absent = [c for c in spec.PANEL_COLUMNS if c not in panel.columns]
    if absent:
        raise AssertionError(f"synthetic_panel does not build {absent}, which the panel contract requires")
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


NARROW_METRO = next(iter(spec.SHOWCASE))


# every metro carries a wide band except one, so the cal block's margin is a
# large negative number and the narrow metro's own band cannot absorb it
def _mixed_width_predictions(panel, wide=1.0, narrow=0.001):
    frame = _no_change_predictions(panel, half_width=wide)
    rows = frame["cbsa_code"] == NARROW_METRO
    frame.loc[rows, "q10"] = -narrow
    frame.loc[rows, "q90"] = narrow
    frame.loc[rows, "lo"] = -narrow
    frame.loc[rows, "hi"] = narrow
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
        self.assertEqual(list(margins.columns), backtest.MARGIN_COLUMNS)
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

    # a band with nothing to calibrate on is not a calibrated band. reporting
    # margin 0.0 with n_cal 0 reads exactly like a model that needed no widening
    def test_an_empty_calibration_block_is_refused(self):
        frame = _no_change_predictions(self.panel, half_width=0.001)
        with self.assertRaises(ValueError) as caught:
            backtest.calibrate(frame[frame["block"] != "cal"])
        self.assertIn("cal", str(caught.exception))

    # cal rows whose outcome is not realized calibrate nothing either
    def test_a_calibration_block_of_nulls_is_refused(self):
        frame = _no_change_predictions(self.panel, half_width=0.001)
        frame.loc[frame["block"] == "cal", "y"] = np.nan
        with self.assertRaises(ValueError):
            backtest.calibrate(frame)

    # the margin is one scalar per horizon and the rows it lands on have their
    # own widths, so a negative margin can push lo past hi on the narrow ones
    def test_a_negative_margin_never_inverts_a_band(self):
        frame = _mixed_width_predictions(self.panel)
        after, margins = backtest.calibrate(frame)
        self.assertTrue((margins["margin"] < 0).all())
        self.assertGreater(margins["crossed"].sum(), 0)
        self.assertTrue((after["hi"] >= after["lo"]).all())
        narrow = after[after["cbsa_code"] == NARROW_METRO]
        mid = (narrow["q10"] + narrow["q90"]) / 2.0
        self.assertTrue(np.allclose(narrow["lo"], mid))
        self.assertTrue(np.allclose(narrow["hi"], mid))

    # a frame concatenated from several models carries a repeated index, and
    # each model has to keep its own margin
    def test_a_repeated_index_calibrates_each_model_on_its_own(self):
        narrow = _no_change_predictions(self.panel, half_width=0.001)
        wider = _no_change_predictions(self.panel, half_width=0.02).assign(model="second")
        both = pd.concat([narrow, wider])
        self.assertFalse(both.index.is_unique)
        after, margins = backtest.calibrate(both)
        self.assertEqual(len(after), len(both))
        self.assertEqual(set(margins["model"]), {"flat", "second"})
        m = margins.set_index(["model", "horizon"])["margin"]
        for name in ("flat", "second"):
            for h in spec.HORIZONS:
                rows = after[(after["model"] == name) & (after["horizon"] == h)]
                self.assertTrue(np.allclose(rows["lo"], rows["q10"] - m[(name, h)]))
                self.assertTrue(np.allclose(rows["hi"], rows["q90"] + m[(name, h)]))
        self.assertGreater(m["flat"].iloc[0], m["second"].iloc[0])


class TestHelpers(unittest.TestCase):
    # the median stays where the model put it and the edges come to it
    def test_order_quantiles(self):
        frame = pd.DataFrame({"q10": [0.3, 0.0], "q50": [0.1, 0.1], "q90": [0.2, 0.2]})
        out = backtest.order_quantiles(frame)
        self.assertEqual(list(out.iloc[0]), [0.1, 0.1, 0.2])
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


# the numbers the readme tables publish, worked by hand on two rows. the no
# change fixture forecasts zero, where pct(y) - pct(q50) and pct(y - q50)
# agree, so a wrong mae_pct passed there, and no test read rmse or width
class TestEvaluateByHand(unittest.TestCase):
    # one metro grew 10 percent against a median of 5, the other grew the 5 it
    # was given. the band is 0.02 wide before calibration and 0.12 after
    @classmethod
    def setUpClass(cls):
        q50 = np.log([1.05, 1.05])
        frame = pd.DataFrame({
            "model": "m", "cbsa_code": ["10180", "12420"], "quarter": "2022Q1", "horizon": 4, "block": "test",
            "y": np.log([1.10, 1.05]), "q10": q50 - 0.01, "q50": q50, "q90": q50 + 0.01,
            "lo": q50 - 0.06, "hi": q50 + 0.06,
        })
        cls.row = backtest.evaluate(frame).iloc[0]

    # a miss of 5 points and a hit, so 2.5. the percent of the log gap would
    # read 100 * (1.10 / 1.05 - 1) / 2, about 2.38
    def test_mae_pct_is_the_gap_between_realized_and_forecast_growth(self):
        self.assertAlmostEqual(self.row["mae_pct"], 2.5)

    # one miss of e = log(1.10 / 1.05) and one hit: mae e / 2, rmse e / sqrt 2
    def test_rmse_is_the_root_mean_square_error_of_the_median(self):
        e = np.log(1.10 / 1.05)
        self.assertAlmostEqual(self.row["mae"], e / 2.0)
        self.assertAlmostEqual(self.row["rmse"], e / np.sqrt(2.0))

    # the width printed beside the coverage is the calibrated band's
    def test_width_is_the_calibrated_band(self):
        self.assertAlmostEqual(self.row["width"], 0.12)


# the band is published as a 90 percent band. every coverage check is one
# sided, at least 1 - ALPHA, and moves with the constant, so a band calibrated
# to 95 percent passed all of them
class TestTheBandIsANinetyPercentBand(unittest.TestCase):
    def test_cal_coverage_lands_at_ninety_percent_not_above(self):
        n = 1000
        y = np.random.default_rng(spec.SEED).normal(0.0, 0.05, n)
        frame = pd.DataFrame({
            "model": "m", "cbsa_code": "10180", "quarter": "2019Q1", "horizon": 4, "block": "cal",
            "y": y, "q10": -0.01, "q50": 0.0, "q90": 0.01,
        })
        after, _ = backtest.calibrate(frame)
        covered = spec.coverage(after["y"], after["lo"], after["hi"])
        # the finite sample rank is ceil(1001 * 0.9) = 901 of 1000, less one
        # if the outcome that sets the margin rounds off its own edge
        self.assertGreaterEqual(covered, 0.9)
        self.assertLessEqual(covered, 0.902)


# the paired test by hand. the first model's median is the outcome itself, so
# its error is zero, and the second's error in percent is whatever the fixture
# says, so each origin's gap is known exactly
class TestPairedTest(unittest.TestCase):
    def pair(self, errors_by_origin, horizon=1):
        first, second = [], []
        for i, errors in enumerate(errors_by_origin):
            quarter = str(pd.Period("2022Q1", freq="Q") + i)
            for m, error in enumerate(errors):
                row = {"cbsa_code": f"{10000 + m}", "quarter": quarter, "horizon": horizon, "block": "test", "y": 0.0}
                first.append({**row, "q50": 0.0})
                second.append({**row, "q50": float(np.log1p(error / 100.0))})
        return pd.DataFrame(first), pd.DataFrame(second)

    def expected(self, gaps, h):
        gaps = np.asarray(gaps, dtype=float)
        T = len(gaps)
        centred = gaps - gaps.mean()
        variance = centred @ centred / T
        for lag in range(1, h):
            variance += 2.0 * (1.0 - lag / h) * (centred[lag:] @ centred[:-lag]) / T
        statistic = gaps.mean() / np.sqrt(variance / T) * np.sqrt((T + 1 - 2 * h + h * (h - 1) / T) / T)
        from scipy import stats
        return statistic, 2.0 * stats.t.sf(abs(statistic), df=T - 1)

    def test_one_quarter_ahead_matches_the_formula(self):
        errors = [[1.0], [3.0], [2.0], [5.0], [4.0], [2.5]]
        first, second = self.pair(errors)
        row = backtest.paired_test(first, second).iloc[0]
        statistic, p = self.expected([-e[0] for e in errors], 1)
        self.assertEqual((row["horizon"], row["origins"], row["samples"]), (1, 6, 6))
        self.assertAlmostEqual(row["difference"], -np.mean([e[0] for e in errors]))
        self.assertAlmostEqual(row["statistic"], statistic)
        self.assertAlmostEqual(row["p_value"], p)
        self.assertLess(row["p_value"], 0.05)

    # at two quarters consecutive origins share a quarter of outcome, so the
    # variance takes the first autocovariance at half weight
    def test_an_overlapping_horizon_counts_its_autocovariance(self):
        errors = [[1.0], [3.0], [2.0], [5.0], [4.0], [2.5], [0.5], [3.5]]
        first, second = self.pair(errors, horizon=2)
        row = backtest.paired_test(first, second).iloc[0]
        statistic, p = self.expected([-e[0] for e in errors], 2)
        self.assertAlmostEqual(row["statistic"], statistic)
        self.assertAlmostEqual(row["p_value"], p)

    # metros at one origin share its shocks, so they are averaged into one gap
    # before the test: two metros that cancel leave that origin at zero
    def test_the_metros_at_an_origin_are_one_observation(self):
        errors = [[2.0, 2.0], [1.0, 5.0], [4.0, 0.0], [3.0, 3.0]]
        first, second = self.pair(errors)
        row = backtest.paired_test(first, second).iloc[0]
        self.assertEqual((row["origins"], row["samples"]), (4, 8))
        statistic, _ = self.expected([-np.mean(e) for e in errors], 1)
        self.assertAlmostEqual(row["statistic"], statistic)

    def test_identical_models_differ_by_nothing(self):
        first, _ = self.pair([[1.0], [2.0], [3.0], [4.0]])
        row = backtest.paired_test(first, first.copy()).iloc[0]
        self.assertEqual((row["difference"], row["p_value"]), (0.0, 1.0))

    def test_a_gap_no_origin_disagrees_with_is_certain(self):
        first, second = self.pair([[2.0], [2.0], [2.0], [2.0]])
        row = backtest.paired_test(first, second).iloc[0]
        self.assertAlmostEqual(row["difference"], -2.0)
        self.assertEqual(row["p_value"], 0.0)

    # only samples both models scored count, and only in the block asked for
    def test_only_shared_samples_in_the_block_count(self):
        first, second = self.pair([[1.0], [3.0], [2.0], [5.0], [4.0]])
        second = second.iloc[1:]
        first = pd.concat([first, first.assign(block="cal", quarter="2019Q1")], ignore_index=True)
        row = backtest.paired_test(first, second).iloc[0]
        self.assertEqual((row["origins"], row["samples"]), (4, 4))

    def test_write_paired_tests_the_shipped_model_against_each_other_one(self):
        first, second = self.pair([[1.0], [3.0], [2.0], [5.0], [4.0]])
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            first.assign(model="seqgru").to_parquet(folder / "predictions_seqgru.parquet", index=False)
            second.assign(model="ridge").to_parquet(folder / "predictions_ridge.parquet", index=False)
            with mock.patch.object(spec, "BACKTEST_DIR", folder / "backtest"):
                path = backtest.write_paired("seqgru", ["no_change", "ridge", "seqgru"], folder=folder)
            out = pd.read_csv(path)
        self.assertEqual(list(out.columns), backtest.PAIRED_COLUMNS)
        self.assertEqual(out[["model", "against"]].values.tolist(), [["seqgru", "ridge"]])
        self.assertLess(out["difference"].iloc[0], 0)


# the online band by hand: one metro, horizon one, the raw band q10 to q90 is
# zero wide around zero, so each score is just how far the outcome landed
# from zero and each margin is a quantile of the scores realized by then
class TestOnlineBands(unittest.TestCase):
    def rows(self, outcomes, start="2010Q1", horizon=1, code="10000", model="m"):
        quarters = [str(pd.Period(start, freq="Q") + i) for i in range(len(outcomes))]
        return pd.DataFrame({"model": model, "cbsa_code": code, "quarter": quarters, "horizon": horizon,
                             "block": "test", "y": outcomes, "q10": 0.0, "q50": 0.0, "q90": 0.0,
                             "lo": np.nan, "hi": np.nan})

    def test_no_band_before_a_realized_score_and_none_from_the_future(self):
        # the outcome of origin i lands at i + 1. origin 0 has nothing realized
        # to calibrate on. origin 1 sees only origin 0's miss of 0.1. the huge
        # miss at origin 3 lands at 4 and reaches origin 4's band, not earlier.
        # at alpha 0.2 the top score of four is the quantile, so it shows
        out = backtest.online_bands(self.rows([0.1, 0.1, 0.1, 5.0, 0.1]), alpha=0.2)
        self.assertTrue(np.isnan(out["lo"].iloc[0]))
        self.assertAlmostEqual(out["hi"].iloc[1], 0.1)
        self.assertAlmostEqual(out["hi"].iloc[3], 0.1)
        self.assertGreater(out["hi"].iloc[4], 0.1)

    def test_a_window_forgets_old_outcomes(self):
        out = backtest.online_bands(self.rows([5.0, 0.1, 0.1, 0.1]), alpha=0.5, window=1)
        self.assertAlmostEqual(out["hi"].iloc[1], 5.0)
        self.assertAlmostEqual(out["hi"].iloc[3], 0.1)

    # every band misses, so with gamma the miss rate falls and the band widens
    # past what the same pool gives without it
    def test_gamma_widens_the_band_after_misses(self):
        outcomes = [0.1 * (i + 1) for i in range(12)]
        still = backtest.online_bands(self.rows(outcomes), alpha=0.5)
        moved = backtest.online_bands(self.rows(outcomes), alpha=0.5, gamma=0.2)
        self.assertGreater(moved["hi"].iloc[-1], still["hi"].iloc[-1])

    def test_a_scaled_score_scales_the_margin_back(self):
        a = self.rows([0.2, 0.2, 0.2], code="10000")
        b = self.rows([0.2, 0.2, 0.2], code="20000")
        scale = {("10000", q): 1.0 for q in a["quarter"]} | {("20000", q): 2.0 for q in b["quarter"]}
        out = backtest.online_bands(pd.concat([a, b], ignore_index=True), alpha=0.5, scale=scale)
        last = out[out["quarter"] == a["quarter"].iloc[-1]].set_index("cbsa_code")["hi"]
        self.assertAlmostEqual(last["20000"], 2 * last["10000"])

    def test_the_interval_score_by_hand(self):
        score = backtest.interval_score([0.0, -0.3, 0.5], [-0.1, -0.1, -0.1], [0.1, 0.1, 0.1], alpha=0.1)
        np.testing.assert_allclose(score, [0.2, 0.2 + 20 * 0.2, 0.2 + 20 * 0.4])


class TestTrailingVolatility(unittest.TestCase):
    def test_it_reads_only_the_quarters_up_to_each_one(self):
        quarters = [str(pd.Period("2000Q1", freq="Q") + i) for i in range(30)]
        growth = np.r_[np.tile([0.01, -0.01], 10), np.full(10, 0.5)]
        # a quieter metro beside it keeps the floor below the values checked
        panel = pd.concat([pd.DataFrame({"cbsa_code": "10000", "quarter": quarters, "hpi_qoq": growth}),
                           pd.DataFrame({"cbsa_code": "20000", "quarter": quarters,
                                         "hpi_qoq": np.tile([0.001, -0.001], 15)})], ignore_index=True)
        sigma = backtest.trailing_volatility(panel, quarters=20)
        self.assertAlmostEqual(sigma[("10000", quarters[19])], np.std(growth[:20], ddof=1))
        self.assertGreater(sigma[("10000", quarters[25])], sigma[("10000", quarters[19])])

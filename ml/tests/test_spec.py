import unittest

import numpy as np
import pandas as pd

from loop import spec


def small_panel():
    rows = []
    for code, start in (("10001", 100.0), ("10002", 200.0)):
        for i, q in enumerate(pd.period_range("2015Q1", "2016Q4", freq="Q")):
            rows.append({"cbsa_code": code, "quarter": str(q), "log_hpi": np.log(start * (1.01 ** i))})
    return pd.DataFrame(rows)


class TestQuarters(unittest.TestCase):
    def test_shift_crosses_years(self):
        self.assertEqual(spec.shift_quarter("2024Q3", 2), "2025Q1")
        self.assertEqual(spec.shift_quarter("2024Q1", -1), "2023Q4")

    def test_quarter_end_and_back(self):
        end = spec.quarter_end("2026Q2")
        self.assertEqual(str(end.date()), "2026-06-30")
        self.assertEqual(spec.quarter_of(end), "2026Q2")


class TestTarget(unittest.TestCase):
    def test_growth_is_log_difference_ahead(self):
        panel = small_panel()
        y = spec.target(panel, 4)
        first = panel[(panel.cbsa_code == "10001") & (panel.quarter == "2015Q1")].index[0]
        self.assertAlmostEqual(y[first], 4 * np.log(1.01))
        self.assertAlmostEqual(spec.pct(y[first]), 100 * (1.01 ** 4 - 1), places=6)

    def test_missing_quarter_gives_null_not_a_wrong_pair(self):
        panel = small_panel()
        panel = panel[panel.quarter != "2015Q3"].reset_index(drop=True)
        y = spec.target(panel, 1)
        row = panel[(panel.cbsa_code == "10001") & (panel.quarter == "2015Q2")].index[0]
        self.assertTrue(np.isnan(y[row]))

    def test_last_quarters_have_no_target(self):
        panel = small_panel()
        y = spec.target(panel, 2)
        tail = panel[panel.quarter.isin(["2016Q3", "2016Q4"])].index
        self.assertTrue(y[tail].isna().all())


class TestBlocks(unittest.TestCase):
    # the outcome quarter alone decides the block. an earlier version mixed the
    # clocks, reading cal off the origin as well as the outcome and test off the
    # origin only, which halved the cal set at eight quarters and dropped every
    # sample whose outcome crossed a boundary
    def test_outcome_decides_the_block(self):
        self.assertEqual(spec.block("2015Q4", 8), "train")   # outcome 2017Q4
        self.assertEqual(spec.block("2016Q1", 8), "cal")     # outcome 2018Q1
        self.assertEqual(spec.block("2018Q1", 8), "cal")     # outcome 2020Q1
        self.assertEqual(spec.block("2020Q1", 8), "test")    # outcome 2022Q1
        self.assertEqual(spec.block("2022Q1", 8), "test")    # outcome 2024Q1
        self.assertEqual(spec.block("2021Q4", 1), "test")    # outcome 2022Q1
        self.assertEqual(spec.block("2017Q3", 1), "train")   # outcome 2017Q4

    # the same origin lands in different blocks at different horizons, because
    # the horizon is what moves the outcome
    def test_the_horizon_moves_the_sample(self):
        self.assertEqual(spec.block("2017Q2", 1), "train")   # outcome 2017Q3
        self.assertEqual(spec.block("2017Q2", 4), "cal")     # outcome 2018Q2
        self.assertEqual(spec.block("2017Q2", 8), "cal")     # outcome 2019Q2

    # every boundary belongs to the earlier block, so no sample sits in two
    def test_the_boundaries_close_on_the_left(self):
        self.assertEqual(spec.block("2017Q3", 1), "train")   # outcome 2017Q4, TRAIN_END
        self.assertEqual(spec.block("2017Q4", 1), "cal")     # outcome 2018Q1, CAL_START
        self.assertEqual(spec.block("2021Q3", 1), "cal")     # outcome 2021Q4, CAL_END
        self.assertEqual(spec.block("2021Q4", 1), "test")    # outcome 2022Q1, TEST_START

    # nothing is discarded now. a sample has exactly one outcome, so it has
    # exactly one block, and none of them straddle
    def test_no_sample_is_dropped(self):
        origins = [f"{y}Q{q}" for y in range(2010, 2027) for q in range(1, 5)]
        origins = [o for o in origins if spec.to_period(o) <= spec.to_period("2026Q2")]
        for h in (1, 2, 4, 8):
            for o in origins:
                self.assertIn(spec.block(o, h), ("train", "cal", "test"), f"{o} h={h}")

    # the calibration window is the four years the readme names, at every
    # horizon. reading it off the origin left eight quarters at h=8, all of
    # them the 2020 to 2021 boom
    def test_the_cal_window_is_the_same_four_years_at_every_horizon(self):
        for h in (1, 2, 4, 8):
            outcomes = sorted(
                spec.to_period(o) + h
                for y in range(2010, 2027) for q in range(1, 5)
                for o in [f"{y}Q{q}"]
                if spec.to_period(o) <= spec.to_period("2026Q2") and spec.block(o, h) == "cal"
            )
            self.assertEqual(len(outcomes), 16, f"h={h}")
            self.assertEqual(outcomes[0], spec.to_period(spec.CAL_START), f"h={h}")
            self.assertEqual(outcomes[-1], spec.to_period(spec.CAL_END), f"h={h}")


class TestMeasures(unittest.TestCase):
    def test_relative_mae_of_no_change_is_one(self):
        y = np.array([0.02, -0.01, 0.05, 0.0])
        self.assertAlmostEqual(spec.relative_mae(y, np.zeros(4)), 1.0)

    def test_pinball_penalises_the_right_side(self):
        y = np.array([1.0])
        self.assertAlmostEqual(spec.pinball(y, np.array([0.0]), 0.9), 0.9)
        self.assertAlmostEqual(spec.pinball(y, np.array([2.0]), 0.9), 0.1)

    def test_coverage_and_width_skip_nulls(self):
        y = np.array([0.0, 1.0, np.nan, 3.0])
        lo = np.array([-1.0, 2.0, 0.0, 2.0])
        hi = np.array([1.0, 3.0, 1.0, 4.0])
        self.assertAlmostEqual(spec.coverage(y, lo, hi), 2 / 3)
        self.assertAlmostEqual(spec.mean_width(lo, hi), 1.5)

    # scores 1 through 10 with the band never binding below. the correction
    # takes the ceil((n+1)(1-alpha)) th score, the 10th, not the 9th. dropping
    # the +1 undercovers by exactly one score and no coverage test notices
    def test_conformal_margin_takes_the_finite_sample_rank(self):
        y = np.arange(1.0, 11.0)
        lo = np.full(10, -100.0)
        hi = np.zeros(10)
        self.assertEqual(spec.conformal_margin(y, lo, hi, alpha=0.1), 10.0)
        self.assertEqual(spec.conformal_margin(y, lo, hi, alpha=0.2), 9.0)

    # (n+1)(1-alpha) can ask for a rank the sample does not have, and the
    # widest score is the most the sample can say
    def test_conformal_margin_caps_at_the_widest_score(self):
        y = np.arange(1.0, 6.0)
        self.assertEqual(spec.conformal_margin(y, np.full(5, -100.0), np.zeros(5), alpha=0.1), 5.0)

    def test_conformal_margin_reaches_nominal_coverage(self):
        rng = np.random.default_rng(spec.SEED)
        y = rng.normal(size=2000)
        lo, hi = np.full(2000, -0.5), np.full(2000, 0.5)
        m = spec.conformal_margin(y, lo, hi, alpha=0.1)
        self.assertGreater(m, 0)
        self.assertGreaterEqual(spec.coverage(y, lo - m, hi + m), 0.9)

    def test_conformal_margin_can_shrink_a_wide_band(self):
        y = np.zeros(50)
        m = spec.conformal_margin(y, np.full(50, -2.0), np.full(50, 2.0))
        self.assertLess(m, 0)


# the outcome was found by counting rows ahead, so a metro missing a quarter
# overshot the one it wanted and the guard nulled a target both endpoints
# support. 44 of the 410 real metros carry a gap
class TestTargetIsFoundByCalendar(unittest.TestCase):
    def frame(self, quarters, values):
        return pd.DataFrame({
            "cbsa_code": ["10180"] * len(quarters),
            "quarter": quarters,
            spec.TARGET_BASE: values,
        })

    def test_a_gap_before_the_outcome_does_not_hide_it(self):
        # 2000Q2 is missing. the two quarter outcome for 2000Q1 is 2000Q3,
        # which is right there
        frame = self.frame(["2000Q1", "2000Q3", "2000Q4"], [1.0, 1.2, 1.3])
        out = spec.target(frame, 2).to_numpy(dtype=float)
        self.assertAlmostEqual(out[0], 0.2)
        self.assertTrue(np.isnan(out[1]))

    def test_an_outcome_that_is_genuinely_absent_is_still_null(self):
        frame = self.frame(["2000Q1", "2000Q4"], [1.0, 1.3])
        out = spec.target(frame, 2).to_numpy(dtype=float)
        self.assertTrue(np.isnan(out).all())

    def test_a_dense_frame_is_unchanged(self):
        frame = self.frame(["2000Q1", "2000Q2", "2000Q3"], [1.0, 1.1, 1.3])
        out = spec.target(frame, 1).to_numpy(dtype=float)
        np.testing.assert_allclose(out[:2], [0.1, 0.2], atol=1e-12)
        self.assertTrue(np.isnan(out[2]))

    def test_the_outcome_never_crosses_a_metro(self):
        frame = pd.DataFrame({
            "cbsa_code": ["10180", "19100"],
            "quarter": ["2000Q1", "2000Q2"],
            spec.TARGET_BASE: [1.0, 5.0],
        })
        self.assertTrue(np.isnan(spec.target(frame, 1).to_numpy(dtype=float)).all())


if __name__ == "__main__":
    unittest.main()

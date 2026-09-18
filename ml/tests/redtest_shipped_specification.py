# a red test. run_tests.py discovers test*.py, so this one runs on its own:
#   .venv/bin/python -m unittest tests.redtest_shipped_specification -v

import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from loop import nets, spec, train

# a feature the shipped refit reads and the scored backtest cannot: it starts
# after the fitting slice ends. permits and income are the two left after the
# 2026-09-18 admission run, and this is the one the control blanks
LATE_COLUMN = "permits_per_1000"

# nets.moments marks a feature unseen when the fitting slice holds under two
# values, and encode() then blanks it in both the value and the presence
# channel on every window, test block included. that rule is right: a fit must
# not standardize by statistics it never saw.
#
# what follows from it is that the fitting slice decides the input
# specification. the backtest fits on the part of the train block left after
# the validation years are taken out, so outcomes through 2014Q4, while the
# shipped refit fits on every labelled window through 2026. a covariate whose
# publisher started after that is therefore read by the model that writes
# forecasts.csv and blanked in the model whose MAE and coverage the accuracy
# page publishes
#
# on 2026-09-18 this stopped naming five columns and started naming two. rents,
# listing prices and inventory were measured by ml/admit.py and left the input
# set; permits and income earned their place and are still in it, still unread
# by the model that is scored


# one row per metro and quarter. prices grow a percent a quarter from the start
# and the late covariate carries values only from `late_start` onward, which is
# what the permit and income series look like against a 1975 panel
def panel_with_a_late_covariate(late_start, first="2005Q1", last="2026Q2", column=LATE_COLUMN):
    quarters = [str(p) for p in pd.period_range(first, last, freq="Q")]
    rows = []
    for code in ("10001", "10002", "10003"):
        for i, q in enumerate(quarters):
            row = {c: np.nan for c in spec.PANEL_COLUMNS}
            row.update({"cbsa_code": code, "quarter": q, "name": f"Metro {code}", "level": "msa",
                        "parent_cbsa": None, "date": spec.quarter_end(q)})
            row["log_hpi"] = np.log(100.0) + 0.01 * i + 0.001 * int(code[-1])
            row["hpi"] = np.exp(row["log_hpi"])
            row["mortgage"] = 5.0 + 0.01 * i
            row["hpi_yoy"] = 0.04
            if q >= late_start:
                row[column] = 0.02 + 0.001 * i
            rows.append(row)
    panel = pd.DataFrame(rows)[spec.PANEL_COLUMNS]
    panel["hpi_qoq"] = panel.groupby("cbsa_code")["log_hpi"].diff()
    return panel


def seen_of(windows, mask):
    stats = nets.feature_stats(windows, mask)
    return ({f: bool(s) for f, s in zip(nets.SEQ_FEATURES, stats["seq_seen"])},
            {f: bool(s) for f, s in zip(nets.STATIC_FEATURES, stats["static_seen"])},
            stats)


def masks(windows):
    ss = train.splits(windows.origins)
    fit = ~np.isnan(np.where(ss == "fit", windows.y, np.nan)).all(axis=1)
    ship = ~np.isnan(windows.y).all(axis=1)
    return fit, ship


class TestTheScoredModelAndTheShippedModelReadTheSameColumns(unittest.TestCase):
    def setUp(self):
        # the publisher starts after the fitting slice ends, which is the
        # shape the permit and income series both have
        self.panel = panel_with_a_late_covariate("2020Q1")
        self.windows = nets.build_windows(self.panel)
        self.fit, self.ship = masks(self.windows)

    def test_both_fitting_slices_hold_windows(self):
        self.assertGreater(self.fit.sum(), 0)
        self.assertGreater(self.ship.sum(), self.fit.sum())

    def test_the_two_fits_read_the_same_features(self):
        back_seq, back_static, _ = seen_of(self.windows, self.fit)
        ship_seq, ship_static, _ = seen_of(self.windows, self.ship)
        blanked = sorted([f for f in back_seq if not back_seq[f] and ship_seq[f]]
                         + [f for f in back_static if not back_static[f] and ship_static[f]])
        self.assertEqual(blanked, [],
                         "the shipped refit reads columns the scored model never saw")

    # and the columns both of them keep are standardized the same way, or the
    # scored model is not the shipped model even where they agree on the inputs
    def test_the_shared_features_standardize_the_same_way(self):
        _, _, back = seen_of(self.windows, self.fit)
        _, _, ship = seen_of(self.windows, self.ship)
        shared = [i for i, f in enumerate(nets.SEQ_FEATURES)
                  if back["seq_seen"][i] and ship["seq_seen"][i]]
        for i in shared:
            self.assertAlmostEqual(float(back["seq_mean"][i]), float(ship["seq_mean"][i]), places=3,
                                   msg=f"{nets.SEQ_FEATURES[i]} mean")

    # the control, and the thing a fix must not undo: a feature the fit never
    # saw is blanked in both channels rather than fed through as a real zero
    def test_a_feature_the_fit_never_saw_is_blanked_in_both_channels(self):
        _, _, back = seen_of(self.windows, self.fit)
        i = nets.STATIC_FEATURES.index(LATE_COLUMN)
        self.assertFalse(bool(back["static_seen"][i]))
        static = nets.encode(self.windows.static, back["static_mean"], back["static_std"], back["static_seen"])
        self.assertEqual(np.count_nonzero(static[:, i]), 0)
        self.assertEqual(static[:, len(nets.STATIC_FEATURES) + i].mean(), 0.0)


# the same question against the panel the published numbers were made from.
# ml/data/panel.parquet is not tracked, so a fresh clone skips this
@unittest.skipUnless(Path(spec.PANEL_PATH).exists(), "ml/data/panel.parquet is not on disk")
class TestTheShippedPanelDivergence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.windows = nets.build_windows(pd.read_parquet(spec.PANEL_PATH))
        cls.fit, cls.ship = masks(cls.windows)

    def test_the_two_fits_read_the_same_features(self):
        back_seq, back_static, _ = seen_of(self.windows, self.fit)
        ship_seq, ship_static, _ = seen_of(self.windows, self.ship)
        blanked = sorted([f for f in back_seq if not back_seq[f] and ship_seq[f]]
                         + [f for f in back_static if not back_static[f] and ship_static[f]])
        self.assertEqual(blanked, [], f"{len(blanked)} columns the accuracy page never scored")


if __name__ == "__main__":
    unittest.main()

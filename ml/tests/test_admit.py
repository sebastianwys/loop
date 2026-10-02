import sys
import types
import unittest

import numpy as np

from loop import nets, spec, train

# admit.py is a script beside the package, not a module inside it
sys.path.insert(0, str(spec.ML_ROOT))
import admit  # noqa: E402


def labels_of(origin):
    return list(admit.split_at(np.array([origin], dtype=object))[0])


# admit fits through 2019Q4 and scores 2020 and 2021, and the outcome quarter
# decides which, the way spec.block does. no test imported admit, so a split by
# origin, or a scored block running into 2022Q1, passed
class TestTheSplitIsByOutcomeQuarter(unittest.TestCase):
    # 2018Q1 fits at one to four quarters and scores at eight, where its
    # outcome lands in 2020Q1
    def test_the_horizon_moves_a_sample_across_the_boundary(self):
        self.assertEqual(labels_of("2018Q1"), ["fit", "fit", "fit", "score"])

    def test_the_fit_block_ends_on_its_last_outcome(self):
        self.assertEqual(labels_of("2019Q3")[0], "fit")      # outcome 2019Q4
        self.assertEqual(labels_of("2019Q4")[0], "score")    # outcome 2020Q1

    def test_nothing_in_the_test_era_is_labelled(self):
        self.assertEqual(labels_of("2021Q3")[0], "score")    # outcome 2021Q4
        self.assertEqual(labels_of("2021Q4"), [None] * 4)    # outcomes from 2022Q1


# the guard reads the label grid the model is handed, so it has to refuse an
# outcome at TEST_START itself, not only the ones after it
class TestTheTestEraIsRefused(unittest.TestCase):
    def windows(self, *origins):
        return types.SimpleNamespace(origins=np.array(origins, dtype=object))

    def test_an_outcome_at_the_test_start_is_refused(self):
        labels = np.array([["score", None, None, None]], dtype=object)
        with self.assertRaises(ValueError) as raised:
            admit.refuse_test_era(self.windows("2021Q4"), labels)
        self.assertIn(spec.TEST_START, str(raised.exception))

    # outcomes 2021Q3 and 2021Q4, the last quarter the scored block may read
    def test_an_outcome_at_the_calibration_end_passes(self):
        labels = np.array([["score", "score", None, None]], dtype=object)
        admit.refuse_test_era(self.windows("2021Q2"), labels)

    # a label of None is a sample neither arm reads, whatever its outcome
    def test_an_unlabelled_sample_is_not_refused(self):
        admit.refuse_test_era(self.windows("2021Q4"), np.array([[None] * 4], dtype=object))

    def test_the_split_admit_runs_passes_its_own_guard(self):
        windows = nets.build_windows(train.synthetic_panel(n_metros=6, start="2000Q1"))
        admit.refuse_test_era(windows, admit.split_at(windows.origins))


# the seen table and the arm check ask which features a fitting block can see,
# through the mask train_one would build: a window is in it when some horizon
# has a realized outcome by the boundary
class TestTheFitMaskIsTheFittingBlock(unittest.TestCase):
    def test_a_window_fits_when_a_realized_outcome_lands_by_the_boundary(self):
        w = nets.build_windows(train.synthetic_panel(n_metros=6, start="2000Q1"))
        outcome = w.t[:, None] + np.asarray(spec.HORIZONS)[None, :]
        for end in (spec.FIT_END, admit.FIT_END):
            expected = ((outcome <= w.index_of(end)) & ~np.isnan(w.y)).any(axis=1)
            self.assertTrue(expected.any() and not expected.all(), end)
            np.testing.assert_array_equal(admit.fit_mask_at(w, end), expected, err_msg=end)

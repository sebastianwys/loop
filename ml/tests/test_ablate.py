import sys
import unittest
from unittest import mock

import numpy as np
import pandas as pd

from loop import nets, spec, train

# ablate.py is a script beside the package, not a module inside it
sys.path.insert(0, str(spec.ML_ROOT))
import ablate  # noqa: E402


# an input set is chosen on the validation loss and nothing else: the fitting
# block trains, the validation block (outcomes 2015 to 2017) scores, and no cal
# or test outcome reaches either. no test imported ablate, so a selection that
# scored on the cal block as well passed
class TestTheAblationChoosesOnValidationOnly(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.calls = []

        # a scripted history stands in for the fit, so the selection rule reads
        # a known curve
        def recorder(model_name, windows, y_fit, y_val=None, *args, **kwargs):
            cls.calls.append((windows, np.array(y_fit, dtype=float), np.array(y_val, dtype=float)))
            return {"history": pd.DataFrame({"epoch": [1, 2, 3], "val_loss": [0.5, 0.3, 0.4]})}

        # validation_loss leaves its input set on nets, as admit.score_arm does
        with mock.patch.object(train, "train_one", recorder), \
             mock.patch.object(nets, "SEQ_FEATURES", list(nets.SEQ_FEATURES)), \
             mock.patch.object(nets, "STATIC_FEATURES", list(nets.STATIC_FEATURES)):
            features = next(iter(ablate.SETS.values()))
            cls.result = ablate.validation_loss("windowmlp", features, train.synthetic_panel(n_metros=6, start="2000Q1"))

    def test_the_model_is_handed_fit_and_val_outcomes_only(self):
        self.assertEqual(len(self.calls), 1)
        windows, y_fit, y_val = self.calls[0]
        table = train.splits(windows.origins)
        realized = ~np.isnan(windows.y)
        np.testing.assert_array_equal(~np.isnan(y_fit), realized & (table == "fit"))
        np.testing.assert_array_equal(~np.isnan(y_val), realized & (table == "val"))
        self.assertTrue(np.isin(table[realized], ["cal", "test"]).any())

    def test_the_input_set_scores_its_best_validation_epoch(self):
        self.assertEqual(self.result, (0.3, 2))

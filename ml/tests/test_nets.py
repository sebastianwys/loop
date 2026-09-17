import unittest

import numpy as np
import pandas as pd
import torch

from loop import nets, spec

torch.manual_seed(spec.SEED)


# one row per metro and quarter with the contract's columns. prices start at
# each metro's first quarter and grow one percent a quarter, covariates are
# simple ramps so a window's contents can be checked by hand
def panel_with_starts(starts, first="2000Q1", last="2009Q4"):
    quarters = [str(p) for p in pd.period_range(first, last, freq="Q")]
    rows = []
    for code, start in starts.items():
        for i, q in enumerate(quarters):
            live = q >= start
            row = {c: np.nan for c in spec.PANEL_COLUMNS}
            row.update({"cbsa_code": code, "quarter": q, "name": f"Metro {code}", "level": "msa", "parent_cbsa": None, "date": spec.quarter_end(q)})
            if live:
                row["log_hpi"] = np.log(100.0) + 0.01 * i
                row["hpi"] = np.exp(row["log_hpi"])
                row["mortgage"] = 5.0 + 0.1 * i
                row["hpi_yoy"] = 0.04
            rows.append(row)
    panel = pd.DataFrame(rows)[spec.PANEL_COLUMNS]
    panel["hpi_qoq"] = panel.groupby("cbsa_code")["log_hpi"].diff()
    return panel


class TestWindows(unittest.TestCase):
    def setUp(self):
        self.panel = panel_with_starts({"10001": "2000Q1", "10002": "2008Q1", "10003": "2007Q4"})
        self.windows = nets.build_windows(self.panel)

    def test_shapes_and_dropped_short_histories(self):
        w = self.windows
        codes = pd.Series(w.codes)
        # 10002 has seven real quarters of hpi_qoq at the end, 10003 exactly eight
        self.assertEqual(set(codes), {"10001", "10003"})
        self.assertEqual(list(w.origins[codes == "10003"]), ["2009Q4"])
        self.assertEqual(int((codes == "10001").sum()), 32)
        self.assertEqual(w.origins[codes == "10001"][0], "2002Q1")
        self.assertEqual(w.seq.shape, (33, spec.WINDOW, len(nets.SEQ_FEATURES)))
        self.assertEqual(w.static.shape, (33, len(nets.STATIC_FEATURES)))
        self.assertEqual(w.y.shape, (33, len(spec.HORIZONS)))
        self.assertEqual(w.index_of("2000Q1"), 0)
        self.assertEqual(w.index_of("2010Q1"), 40)

    def test_tensors_carry_values_and_presence_masks(self):
        w = self.windows
        stats = nets.feature_stats(w, np.ones(len(w), dtype=bool))
        seq, static, metro, y = nets.to_tensors(w, stats)
        n_seq, n_static = len(nets.SEQ_FEATURES), len(nets.STATIC_FEATURES)
        self.assertEqual(tuple(seq.shape), (33, spec.WINDOW, 2 * n_seq))
        self.assertEqual(tuple(static.shape), (33, 2 * n_static))
        self.assertEqual(metro.dtype, torch.int64)
        mask = seq[:, :, n_seq:].numpy()
        values = seq[:, :, :n_seq].numpy()
        np.testing.assert_array_equal(mask, (~np.isnan(w.seq)).astype(np.float32))
        self.assertTrue(np.all(values[mask == 0] == 0.0))
        # the earliest window of 10001 reaches before the panel: eight real
        # quarters of hpi_qoq, nine of mortgage, nothing in the static vector
        first = int(np.nonzero((w.codes == "10001") & (w.origins == "2002Q1"))[0][0])
        self.assertEqual(int(mask[first, :, nets.SEQ_FEATURES.index("hpi_qoq")].sum()), 8)
        self.assertEqual(int(mask[first, :, nets.SEQ_FEATURES.index("mortgage")].sum()), 9)
        self.assertEqual(int(static[first, n_static:].sum()), 0)
        self.assertTrue(torch.isnan(y[first, spec.HORIZONS.index(8)]).item() is False)
        # values are standardized with the stats they were given
        j = nets.SEQ_FEATURES.index("mortgage")
        raw = w.seq[first, -1, j]
        self.assertAlmostEqual(float(values[first, -1, j]), (raw - stats["seq_mean"][j]) / stats["seq_std"][j], places=5)

    def test_stats_come_from_the_masked_windows_only(self):
        w = self.windows
        mask = w.origins <= "2005Q4"
        before = nets.feature_stats(w, mask)
        j = nets.SEQ_FEATURES.index("mortgage")
        expected = np.nanmean(w.seq[mask][:, :, j])
        self.assertAlmostEqual(float(before["seq_mean"][j]), float(expected), places=5)
        # corrupt everything outside the mask and the statistics do not move
        w.seq[~mask] *= 1000.0
        w.static[~mask] = 99.0
        after = nets.feature_stats(w, mask)
        for key in before:
            np.testing.assert_array_equal(before[key], after[key])
        # a feature never seen keeps mean zero and std one
        k = nets.SEQ_FEATURES.index("unemp")
        self.assertEqual(float(before["seq_mean"][k]), 0.0)
        self.assertEqual(float(before["seq_std"][k]), 1.0)
        self.assertFalse(before["seq_seen"][k])
        self.assertTrue(np.all(before["static_std"] == 1.0))

    def test_feature_unseen_in_the_fitting_set_is_blanked(self):
        w = nets.build_windows(self.panel)
        mask = w.origins <= "2005Q4"
        k = nets.SEQ_FEATURES.index("unemp")
        a = nets.STATIC_FEATURES.index("pop_growth")
        # unemp and pop_growth appear only after the fitting set ends
        w.seq[~mask, :, k] = 7.0
        w.static[~mask, a] = 0.01
        stats = nets.feature_stats(w, mask)
        self.assertFalse(stats["seq_seen"][k])
        self.assertTrue(stats["seq_seen"][nets.SEQ_FEATURES.index("mortgage")])
        seq, static, _, _ = nets.to_tensors(w, stats)
        n_seq, n_static = len(nets.SEQ_FEATURES), len(nets.STATIC_FEATURES)
        self.assertEqual(float(seq[:, :, k].abs().sum()), 0.0)
        self.assertEqual(float(seq[:, :, n_seq + k].sum()), 0.0)
        self.assertEqual(float(static[:, a].abs().sum()), 0.0)
        self.assertEqual(float(static[:, n_static + a].sum()), 0.0)
        # the same values are read once the fitting set includes them
        stats = nets.feature_stats(w, np.ones(len(w), dtype=bool))
        seq, static, _, _ = nets.to_tensors(w, stats)
        self.assertEqual(float(seq[~mask][:, :, n_seq + k].mean()), 1.0)
        self.assertEqual(float(static[~mask][:, n_static + a].mean()), 1.0)

    def test_targets_match_the_spec_definition(self):
        panel = self.panel[~((self.panel.cbsa_code == "10001") & (self.panel.quarter == "2004Q3"))].reset_index(drop=True)
        w = nets.build_windows(panel)
        keys = pd.DataFrame({"cbsa_code": w.codes, "quarter": w.origins})
        for j, h in enumerate(spec.HORIZONS):
            contract = panel[["cbsa_code", "quarter"]].assign(y=spec.target(panel, h))
            merged = keys.merge(contract, on=["cbsa_code", "quarter"], how="left")
            np.testing.assert_allclose(w.y[:, j], merged["y"].to_numpy(dtype=np.float32), rtol=1e-6, equal_nan=True)
        # the quarter before the hole has no one step target, the window at the hole is gone
        row = np.nonzero((w.codes == "10001") & (w.origins == "2004Q2"))[0][0]
        self.assertTrue(np.isnan(w.y[row, spec.HORIZONS.index(1)]))
        self.assertFalse(np.any((w.codes == "10001") & (w.origins == "2004Q3")))


class TestModels(unittest.TestCase):
    def inputs(self, n=16):
        seq = torch.randn(n, spec.WINDOW, 2 * len(nets.SEQ_FEATURES))
        static = torch.randn(n, 2 * len(nets.STATIC_FEATURES))
        metro = torch.randint(0, 5, (n,))
        return seq, static, metro

    def test_both_models_output_monotone_quantiles(self):
        for cls in (nets.WindowMLP, nets.SeqGRU):
            model = cls(5)
            model.set_target_stats(np.array([0.01, 0.02, 0.04, 0.08]), np.array([0.01, 0.02, 0.03, 0.05]))
            out = model(*self.inputs())
            self.assertEqual(tuple(out.shape), (16, len(spec.HORIZONS), len(spec.QUANTILES)))
            self.assertTrue(bool((out[..., :-1] <= out[..., 1:]).all()), cls.__name__)

    def test_monotone_head_is_exact_at_the_median(self):
        raw = torch.tensor([[[0.0, 0.3, 0.0]]])
        q = nets.monotone(raw)
        step = float(torch.nn.functional.softplus(torch.tensor(0.0)))
        self.assertAlmostEqual(float(q[0, 0, 1]), 0.3)
        self.assertAlmostEqual(float(q[0, 0, 0]), 0.3 - step, places=6)
        self.assertAlmostEqual(float(q[0, 0, 2]), 0.3 + step, places=6)

    # the widths used to be default arguments, so they were fixed when the
    # module was imported. an ablation that changes the feature list then built
    # a model expecting the old channel count, which is silent until the shapes
    # disagree deep in a forward pass
    def test_input_width_follows_the_feature_list_at_build_time(self):
        original = nets.SEQ_FEATURES
        try:
            nets.SEQ_FEATURES = original[:3]
            self.assertEqual(nets.SeqGRU(5).gru.input_size, 6)
            nets.SEQ_FEATURES = original
            self.assertEqual(nets.SeqGRU(5).gru.input_size, 2 * len(original))
        finally:
            nets.SEQ_FEATURES = original

    def test_explicit_widths_win_over_the_feature_list(self):
        model = nets.SeqGRU(5, n_seq=14, n_static=6)
        self.assertEqual(model.gru.input_size, 14)
        self.assertEqual(model.head.in_features, nets.HIDDEN_GRU + 6 + nets.EMBED)

    def test_state_dict_carries_target_stats(self):
        model = nets.WindowMLP(3)
        model.set_target_stats(np.full(4, 0.02), np.full(4, 0.05))
        state = model.state_dict()
        self.assertIn("y_loc", state)
        self.assertAlmostEqual(float(state["y_scale"][0]), 0.05)


class TestPinball(unittest.TestCase):
    def test_zero_when_every_quantile_hits_the_outcome(self):
        y = torch.tensor([[0.01, 0.02, 0.04, 0.08]])
        pred = y.unsqueeze(-1).repeat(1, 1, len(spec.QUANTILES))
        self.assertEqual(float(nets.pinball_loss(pred, y)), 0.0)

    def test_penalizes_the_correct_side(self):
        y = torch.tensor([[1.0]])
        hit = torch.tensor([[[1.0, 1.0, 1.0]]])
        low_q10 = hit.clone()
        low_q10[0, 0, 0] = 0.0
        high_q90 = hit.clone()
        high_q90[0, 0, 2] = 2.0
        low_q90 = hit.clone()
        low_q90[0, 0, 2] = 0.0
        # a quantile under the outcome costs tau per unit, over it costs 1 - tau
        self.assertAlmostEqual(float(nets.pinball_loss(low_q10, y)), 0.1 / 3, places=6)
        self.assertAlmostEqual(float(nets.pinball_loss(high_q90, y)), 0.1 / 3, places=6)
        self.assertAlmostEqual(float(nets.pinball_loss(low_q90, y)), 0.9 / 3, places=6)

    def test_missing_outcomes_drop_out(self):
        y = torch.tensor([[1.0, 2.0], [float("nan"), 2.0]])
        pred = torch.zeros(2, 2, len(spec.QUANTILES))
        full = nets.pinball_loss(pred[:1], y[:1])
        with_gap = nets.pinball_loss(pred, y)
        # three valid cells with outcomes 1, 2, 2 against zero predictions
        self.assertAlmostEqual(float(with_gap), 0.5 * (1.0 + 2.0 + 2.0) / 3, places=6)
        self.assertAlmostEqual(float(full), 0.5 * (1.0 + 2.0) / 2, places=6)
        self.assertEqual(float(nets.pinball_loss(pred, torch.full_like(y, float("nan")))), 0.0)


if __name__ == "__main__":
    unittest.main()

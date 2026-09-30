# a red test. run_tests.py discovers test*.py, so this one runs on its own:
#   .venv/bin/python -m unittest tests.redtest_admit_seed -v

import sys
import unittest

import torch

from loop import nets, spec, train

# admit.py is a script beside the package, not a module inside it
sys.path.insert(0, str(spec.ML_ROOT))
import admit  # noqa: E402

# admit.py scores every arm on five seeds, and ml/README.md reads the spread of
# those five, 36 to 51 parts per million, as the noise an input has to clear.
# a seed spread is that only if the seed moves every random draw of a run: the
# weights the network starts from and the order the fitting windows are
# batched in.
#
# with_seed swaps train.seed_everything for one that seeds the weight init
# with the run's seed. the batch order does not come from there: train_one
# seeds its DataLoader generator from spec.SEED, which admit never sets, so
# every seed of an arm walks the same batches. moving spec.SEED instead moves
# the first batch and keeps the weights, which is how the cause was checked.
# the comment above with_seed predates 05d1417, after which reassigning
# spec.SEED moves both draws
#
# the tests stop each run at the first batch the network is trained on, before
# any optimizer step. nothing is fitted and nothing is written

SEEDS = [spec.SEED + i for i in range(5)]


class FirstBatch(Exception):
    pass


# the first rows the network is handed in training, in order, and the weights
# it holds when it gets them, for one seed of admit's nine arm
def first_step(panel, seed):
    seen = {}

    def hook(module, inputs):
        if module.training and isinstance(module, (nets.SeqGRU, nets.WindowMLP)):
            seen["batch"] = tuple(x.detach().cpu().numpy().tobytes() for x in inputs)
            seen["weights"] = tuple(v.detach().cpu().numpy().tobytes() for v in module.state_dict().values())
            raise FirstBatch

    shipped = list(nets.SEQ_FEATURES), list(nets.STATIC_FEATURES)
    handle = torch.nn.modules.module.register_module_forward_pre_hook(hook)
    try:
        admit.score_arm("seqgru", admit.SEEN_SEQ, admit.SEEN_STATIC, panel, seed, max_epochs=1, verbose=False)
    except FirstBatch:
        pass
    finally:
        handle.remove()
        # score_arm leaves the arm's feature lists on nets, admit.main puts
        # them back and so does this
        nets.SEQ_FEATURES, nets.STATIC_FEATURES = shipped
    return seen


class TestAdmitSeedsVaryTheWholeRun(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        panel = train.synthetic_panel(n_metros=6, start="2000Q1")
        cls.steps = {seed: first_step(panel, seed) for seed in SEEDS}

    def test_every_run_reached_a_training_batch(self):
        for seed, seen in self.steps.items():
            self.assertIn("batch", seen, f"seed {seed} never handed the network a training batch")

    # the control, and the thing a fix must keep: each seed starts the network
    # from its own weights
    def test_each_seed_starts_from_its_own_weights(self):
        distinct = {seen["weights"] for seen in self.steps.values()}
        self.assertEqual(len(distinct), len(SEEDS))

    def test_each_seed_draws_its_own_batch_order(self):
        distinct = {seen["batch"] for seen in self.steps.values()}
        self.assertEqual(len(distinct), len(SEEDS),
                         f"{len(SEEDS)} admit seeds {SEEDS[0]} to {SEEDS[-1]} train on {len(distinct)} batch order(s): "
                         "the seed reaches the weight init and not the batches")


if __name__ == "__main__":
    unittest.main()

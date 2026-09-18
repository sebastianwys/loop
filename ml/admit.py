# the admission gate for features the shipped fitting block cannot see.
#
# ablate.py decides an input on the validation loss, and every column in
# spec.FEATURES is supposed to have passed there. five of the fourteen never
# did. feature_stats takes its seen mask from the fit block and to_tensors
# encodes every window with that mask, validation included, so a feature the
# fit block never observes is blanked in the validation block too: both arms
# of the ablation see the same zeros and the comparison cannot move. rents,
# permits, income, listing prices and inventory are in the model because the
# shipped refit's fitting window happens to reach 2026, not because they were
# measured.
#
# this runs the same gate at a boundary where they are visible. fit through
# 2019Q4, score on the outcomes realized in 2020 and 2021. the test block
# (outcomes from 2022Q1) is never read by either arm, and a guard on the
# arrays the model is actually handed refuses the run if it ever is.
#
# from ml:  .venv/bin/python admit.py [model] [--seeds N] [--epochs N] [--loo|--pairs]

import argparse
import time

import numpy as np
import pandas as pd

from loop import nets, spec, train

# the fit block ends here and the scored block runs from the next quarter to
# SCORE_END. 2019Q4 is the last boundary that leaves a scored block clear of
# the test era: four of the five unmeasured features are visible by then, and
# inventory_yoy starts 2020Q1, so no fit window can see it without eating the
# block that would score it
FIT_END = "2019Q4"
SCORE_END = "2021Q4"

# the nine the shipped fitting block can see, and so the only nine the
# published ablation table ever really compared. measured, not assumed:
# check_arms re-derives this from the panel and fails if it has drifted
SEEN_SEQ = ["hpi_qoq", "hpi_yoy", "unemp", "mortgage", "zhvi_yoy", "hpi_exp_yoy", "hpi_rstderr"]
SEEN_STATIC = ["pop_growth", "domestic_migration_rate"]

# the four that become visible at the new boundary, and the one that does not
ADDED_SEQ = ["zori_yoy", "listing_price_yoy"]
ADDED_STATIC = ["permits_per_1000", "income_growth"]
UNREACHABLE = "inventory_yoy"

# the fourteen this experiment was run against, written out rather than read
# from nets, so the script still reproduces the run after its own result is
# applied and the shipped lists shrink
ALL_SEQ = SEEN_SEQ[:5] + ADDED_SEQ + [UNREACHABLE] + SEEN_SEQ[5:]
ALL_STATIC = SEEN_STATIC + ADDED_STATIC

ARMS = {
    "nine, what the shipped gate could see": (SEEN_SEQ, SEEN_STATIC),
    "thirteen, plus rents listings permits income": (SEEN_SEQ + ADDED_SEQ, SEEN_STATIC + ADDED_STATIC),
    "fourteen, the set shipped before 2026-09-18": (ALL_SEQ, ALL_STATIC),
}


# four features admitted together is one result. which of them carries it is a
# second, and a thirteen arm with one of them held out answers it
def leave_one_out():
    arms = {"thirteen, all four": (SEEN_SEQ + ADDED_SEQ, SEEN_STATIC + ADDED_STATIC)}
    for dropped in ADDED_SEQ + ADDED_STATIC:
        arms[f"twelve, without {dropped}"] = (
            [f for f in SEEN_SEQ + ADDED_SEQ if f != dropped],
            [f for f in SEEN_STATIC + ADDED_STATIC if f != dropped],
        )
    arms["nine, none of the four"] = (SEEN_SEQ, SEEN_STATIC)
    return arms


# leave-one-out cannot separate two features that stand in for each other: pull
# either and the other covers. these two arms carry the same eleven series and
# differ only in which pair was kept, so the comparison is capacity matched
def pairs():
    return {
        "eleven, without zori and listings": (SEEN_SEQ, SEEN_STATIC + ADDED_STATIC),
        "eleven, without permits and income": (SEEN_SEQ + ADDED_SEQ, SEEN_STATIC),
    }


# candidate boundaries, printed so the run states its own premise
BOUNDARIES = ["2014Q4", "2017Q4", "2019Q4", "2020Q4"]


# which part of this experiment a sample feeds, by origin and horizon. the
# outcome quarter decides it, the same rule spec.block uses, only with the
# boundary moved. None is a sample neither arm may touch
def split_at(origins, fit_end=FIT_END, score_end=SCORE_END):
    fit_p, score_p = spec.to_period(fit_end), spec.to_period(score_end)
    table = {}
    for o in np.unique(origins):
        row = []
        for h in spec.HORIZONS:
            outcome = spec.to_period(o) + h
            row.append("fit" if outcome <= fit_p else "score" if outcome <= score_p else None)
        table[o] = row
    return np.array([table[o] for o in origins], dtype=object)


# a window is in the fitting set if any horizon of it has a realized fit
# outcome, which is the rule train_one applies to build its own mask
def fit_mask_at(windows, fit_end):
    labels = split_at(windows.origins, fit_end, fit_end)
    return ~np.isnan(np.where(labels == "fit", windows.y, np.nan)).all(axis=1)


# nothing realized in the test era may reach either arm. this reads the label
# grid the split produced rather than trusting the dates it was built from
def refuse_test_era(windows, labels):
    test_start = spec.to_period(spec.TEST_START)
    used = labels != None  # noqa: E711, an object array needs the elementwise compare
    for j, h in enumerate(spec.HORIZONS):
        outcomes = np.array([spec.to_period(o) + h for o in windows.origins[used[:, j]]])
        if outcomes.size and max(outcomes) >= test_start:
            raise ValueError(f"horizon {h} reaches {max(outcomes)}, which is in the test block")


def seen_table(windows):
    names = ALL_SEQ + ALL_STATIC
    rows = []
    for end in BOUNDARIES:
        mask = fit_mask_at(windows, end)
        stats = nets.feature_stats(windows, mask)
        seen = np.concatenate([stats["seq_seen"], stats["static_seen"]])
        rows.append({"fit through": end, "fit windows": int(mask.sum()),
                     "features seen": f"{int(seen.sum())}/{len(names)}",
                     "unseen": ", ".join(n for n, s in zip(names, seen) if not s) or "none"})
    return pd.DataFrame(rows)


# the arms are written out above so the script reads as a comparison rather
# than a derivation, which means they can go stale. this is the check
def check_arms(windows):
    names = ALL_SEQ + ALL_STATIC
    stats = nets.feature_stats(windows, fit_mask_at(windows, "2014Q4"))
    seen = np.concatenate([stats["seq_seen"], stats["static_seen"]])
    measured = sorted(n for n, s in zip(names, seen) if s)
    if measured != sorted(SEEN_SEQ + SEEN_STATIC):
        raise ValueError(f"the shipped fitting block now sees {measured}, not the nine this script compares")
    stats = nets.feature_stats(windows, fit_mask_at(windows, FIT_END))
    seen = np.concatenate([stats["seq_seen"], stats["static_seen"]])
    unseen = [n for n, s in zip(names, seen) if not s]
    if unseen != [UNREACHABLE]:
        raise ValueError(f"fitting through {FIT_END} leaves {unseen} unseen, not just {UNREACHABLE}")


# train_one seeds itself from spec.SEED through a default argument bound at
# import, so reassigning spec.SEED moves the batch order and not the weights.
# replacing the function is the only way to vary a run end to end
def with_seed(seed):
    original = train.seed_everything
    return original, lambda *_: original(seed)


def score_arm(model_name, seq_features, static_features, panel, seed, max_epochs, verbose):
    nets.SEQ_FEATURES = list(seq_features)
    nets.STATIC_FEATURES = list(static_features)
    windows = nets.build_windows(panel)
    labels = split_at(windows.origins)
    refuse_test_era(windows, labels)

    y_fit = np.where(labels == "fit", windows.y, np.nan)
    y_score = np.where(labels == "score", windows.y, np.nan)
    original, patched = with_seed(seed)
    train.seed_everything = patched
    try:
        fitted = train.train_one(model_name, windows, y_fit, y_score, max_epochs=max_epochs, verbose=verbose)
    finally:
        train.seed_everything = original

    history = fitted["history"]
    best = history["val_loss"].idxmin()
    row = {"validation loss": round(float(history.loc[best, "val_loss"]), 6),
           "epoch": int(history.loc[best, "epoch"])}

    # mae in percentage points on the scored block, at the restored best epoch
    score_idx = np.nonzero((labels == "score").any(axis=1))[0]
    pred = train.predict(fitted["model"], fitted["inputs"], score_idx, fitted["device"])
    for j, h in enumerate(spec.HORIZONS):
        keep = (labels[score_idx, j] == "score") & ~np.isnan(windows.y[score_idx, j])
        row[f"mae {h}q"] = round(train.mae_pct(windows.y[score_idx][keep, j], pred[keep, j, nets.MEDIAN]), 3)
    row["scored"] = int(((labels == "score") & ~np.isnan(windows.y)).sum())
    row["fitted"] = int(((labels == "fit") & ~np.isnan(windows.y)).sum())
    return row


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model", nargs="?", default="seqgru")
    parser.add_argument("--seeds", type=int, default=3)
    parser.add_argument("--epochs", type=int, default=train.MAX_EPOCHS)
    parser.add_argument("--loo", action="store_true", help="hold each admitted feature out of the thirteen in turn")
    parser.add_argument("--pairs", action="store_true", help="drop each pair together, capacity matched at eleven series")
    parser.add_argument("--out", default=None)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    arms = pairs() if args.pairs else leave_one_out() if args.loo else ARMS
    default_out = "admission_pairs.csv" if args.pairs else "admission_loo.csv" if args.loo else "admission.csv"
    result_path = spec.ML_ROOT / "results" / (args.out or default_out)

    panel = pd.read_parquet(spec.PANEL_PATH)
    shipped_seq, shipped_static = list(nets.SEQ_FEATURES), list(nets.STATIC_FEATURES)
    nets.SEQ_FEATURES, nets.STATIC_FEATURES = list(ALL_SEQ), list(ALL_STATIC)
    windows = nets.build_windows(panel)
    print(seen_table(windows).to_string(index=False))
    check_arms(windows)
    print(f"\nfit through {FIT_END}, score on outcomes {spec.shift_quarter(FIT_END, 1)} to {SCORE_END}, "
          f"{args.seeds} seed(s), test block untouched\n")

    rows = []
    try:
        for label, (seq_features, static_features) in arms.items():
            for run, seed in enumerate(spec.SEED + np.arange(args.seeds)):
                started = time.time()
                row = score_arm(args.model, seq_features, static_features, panel, int(seed), args.epochs, args.verbose)
                rows.append({"arm": label, "series": len(seq_features) + len(static_features), "seed": int(seed), **row})
                print(f"{label:44s} seed {run + 1}  {row['validation loss']:.6f} at epoch {row['epoch']:2d}  "
                      f"4q mae {row['mae 4q']:.2f}  ({time.time() - started:.0f}s)", flush=True)
    finally:
        nets.SEQ_FEATURES, nets.STATIC_FEATURES = shipped_seq, shipped_static

    table = pd.DataFrame(rows)
    table.to_csv(result_path, index=False)
    print()
    print(table.to_string(index=False))
    summary = table.groupby(["arm", "series"], sort=False).agg(
        runs=("validation loss", "size"),
        mean_loss=("validation loss", "mean"),
        worst_loss=("validation loss", "max"),
        best_loss=("validation loss", "min"),
        mean_mae_4q=("mae 4q", "mean"),
        mean_mae_8q=("mae 8q", "mean"),
    ).round(6).reset_index()
    print()
    print(summary.to_string(index=False))
    print(f"\nwrote {result_path}")


if __name__ == "__main__":
    main()

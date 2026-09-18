# which inputs the networks read, decided on the validation block and nothing
# else. the cal and test blocks are never touched here, so running this cannot
# leak a choice into the published numbers
#
# from ml:  .venv/bin/python ablate.py [model]

import sys
import time

import numpy as np
import pandas as pd

from loop import nets, spec, train

# rents, listing prices and inventory left this list on 2026-09-18: they were
# never visible in the fitting block, so every row below scored them as zeros.
# admit.py is the gate that can see them
BASE = ["hpi_qoq", "hpi_yoy", "unemp", "mortgage", "zhvi_yoy"]
STATIC = ["permits_per_1000", "pop_growth", "domestic_migration_rate", "income_growth"]

# the shipped set first, then what was tried against it. the order is the order
# the readme's table reads in
SETS = {
    "seven series, the shipped set": BASE + ["hpi_exp_yoy", "hpi_rstderr"],
    "plus both forms of the index error": BASE + ["hpi_exp_yoy", "hpi_rstderr", "hpi_rstderr_rel"],
    "expanded index, no error": BASE + ["hpi_exp_yoy"],
    "the error as a percent of the index": BASE + ["hpi_exp_yoy", "hpi_rstderr_rel"],
    "five series, no expanded index": BASE,
    "plus the metro against the cross section": BASE + ["hpi_yoy_rel"],
    "plus the calendar quarter": BASE + ["quarter_sin", "quarter_cos"],
    "plus the national series": BASE + ["cpi_yoy", "treasury_10y", "term_spread", "natl_unemp"],
}


def validation_loss(model_name, seq_features, panel):
    nets.SEQ_FEATURES = list(seq_features)
    nets.STATIC_FEATURES = list(STATIC)
    windows = nets.build_windows(panel)
    sample_splits = train.splits(windows.origins)
    y_fit = np.where(sample_splits == "fit", windows.y, np.nan)
    y_val = np.where(sample_splits == "val", windows.y, np.nan)
    history = train.train_one(model_name, windows, y_fit, y_val, verbose=False)["history"]
    best = history["val_loss"].idxmin()
    return float(history.loc[best, "val_loss"]), int(history.loc[best, "epoch"])


def main():
    model_name = sys.argv[1] if len(sys.argv) > 1 else "seqgru"
    panel = pd.read_parquet(spec.PANEL_PATH)
    shipped = list(nets.SEQ_FEATURES)
    rows = []
    for label, features in SETS.items():
        started = time.time()
        loss, epoch = validation_loss(model_name, features, panel)
        rows.append({"input set": label, "series": len(features), "validation loss": round(loss, 6), "epoch": epoch})
        print(f"{label:42s} {loss:.6f} at epoch {epoch:2d}  ({time.time() - started:.0f}s)", flush=True)
    nets.SEQ_FEATURES = shipped
    print()
    print(pd.DataFrame(rows).to_string(index=False))


if __name__ == "__main__":
    main()

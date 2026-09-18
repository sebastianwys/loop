# torch side of the forecast: the panel cut into windows, two small networks
# with monotone quantile heads, and the pinball loss they train on. the
# protocol (blocks, early stopping, conformal step) lives in train.py

import numpy as np
import pandas as pd
import torch
from numpy.lib.stride_tricks import sliding_window_view
from torch import nn
from torch.nn import functional as F

from loop import spec

# quarterly features read as a sequence over the window, annual ones read once
# at the origin. hpi_qoq comes first because it decides whether a window counts
SEQ_FEATURES = list(spec.SEQ_FEATURES)
STATIC_FEATURES = list(spec.STATIC_FEATURES)
MIN_HISTORY = 8
CLIP = 6.0
EMBED = 8
HIDDEN_MLP = (128, 64)
HIDDEN_GRU = 64

N_HORIZONS = len(spec.HORIZONS)
N_QUANTILES = len(spec.QUANTILES)
MEDIAN = spec.QUANTILES.index(0.5)


# raw windows before any scaling: nan marks a missing value. one entry per
# metro and origin, targets per horizon with nan where the outcome is not in
# the panel. t is the origin's position in quarters, so t + h is the outcome
class Windows:
    def __init__(self, seq, static, metro, t, y, metros, quarters):
        self.seq = seq
        self.static = static
        self.metro = metro
        self.t = t
        self.y = y
        self.metros = metros
        self.quarters = quarters
        self.codes = np.asarray(metros, dtype=object)[metro]
        self.origins = np.asarray(quarters, dtype=object)[t]

    def __len__(self):
        return len(self.metro)

    # position of a quarter on the window's time axis, beyond the panel allowed
    def index_of(self, quarter):
        return (spec.to_period(quarter) - spec.to_period(self.quarters[0])).n


def grid(panel, column, metros, quarters):
    table = panel.pivot(index="cbsa_code", columns="quarter", values=column)
    return table.reindex(index=metros, columns=quarters).to_numpy(dtype=np.float64)


def build_windows(panel, window=spec.WINDOW, min_history=MIN_HISTORY):
    panel = panel.assign(cbsa_code=panel["cbsa_code"].astype(str))
    metros = sorted(panel["cbsa_code"].unique())
    periods = pd.period_range(panel["quarter"].min(), panel["quarter"].max(), freq="Q")
    quarters = [str(p) for p in periods]
    n_metros = len(metros)

    log_hpi = grid(panel, spec.TARGET_BASE, metros, quarters)
    seq = np.stack([grid(panel, f, metros, quarters) for f in SEQ_FEATURES], axis=-1)
    static = np.stack([grid(panel, f, metros, quarters) for f in STATIC_FEATURES], axis=-1)

    # pad the left so every quarter can be an origin, then slide a window
    # ending at each origin. the view is (metro, origin, feature, step)
    pad = np.full((n_metros, window - 1, len(SEQ_FEATURES)), np.nan)
    view = sliding_window_view(np.concatenate([pad, seq], axis=1), window, axis=1)
    view = np.moveaxis(view, -1, 2)

    real = (~np.isnan(view[:, :, :, SEQ_FEATURES.index("hpi_qoq")])).sum(axis=-1)
    usable = (real >= min_history) & ~np.isnan(log_hpi)
    metro_idx, t_idx = np.nonzero(usable)

    # targets come from the contract's own definition, laid on the same grid
    y = np.full((len(metro_idx), N_HORIZONS), np.nan, dtype=np.float32)
    keyed = panel[spec.KEY].copy()
    for j, h in enumerate(spec.HORIZONS):
        keyed["y"] = spec.target(panel, h)
        y[:, j] = grid(keyed, "y", metros, quarters)[metro_idx, t_idx]

    return Windows(
        seq=view[metro_idx, t_idx].astype(np.float32),
        static=static[metro_idx, t_idx].astype(np.float32),
        metro=metro_idx.astype(np.int64),
        t=t_idx.astype(np.int64),
        y=y,
        metros=metros,
        quarters=quarters,
    )


# mean and std per feature over the values present, ignoring nan, and a
# flag for features with at least two values. an unseen feature keeps mean 0
# and std 1, and encode() blanks it so a fit never reads what it never saw
def moments(values):
    flat = values.reshape(-1, values.shape[-1]).astype(np.float64)
    present = ~np.isnan(flat)
    count = present.sum(axis=0)
    safe = np.maximum(count, 1)
    filled = np.where(present, flat, 0.0)
    mean = filled.sum(axis=0) / safe
    var = np.where(present, (flat - mean) ** 2, 0.0).sum(axis=0) / safe
    std = np.sqrt(var)
    seen = count >= 2
    mean = np.where(seen, mean, 0.0)
    std = np.where(seen & (std > 1e-6), std, 1.0)
    return mean.astype(np.float32), std.astype(np.float32), seen


def feature_stats(windows, mask):
    mask = np.asarray(mask, dtype=bool)
    seq_mean, seq_std, seq_seen = moments(windows.seq[mask])
    static_mean, static_std, static_seen = moments(windows.static[mask])
    return {
        "seq_mean": seq_mean,
        "seq_std": seq_std,
        "seq_seen": seq_seen,
        "static_mean": static_mean,
        "static_std": static_std,
        "static_seen": static_seen,
    }


# standardize, put zero where a value is missing or the feature is unseen,
# and append one presence channel per feature so the model can tell a real
# zero from a gap
def encode(values, mean, std, seen, clip=CLIP):
    present = ~np.isnan(values) & seen
    z = np.where(present, (values - mean) / std, 0.0)
    z = np.clip(z, -clip, clip)
    return np.concatenate([z, present.astype(np.float32)], axis=-1).astype(np.float32)


def to_tensors(windows, stats, clip=CLIP):
    seq = encode(windows.seq, stats["seq_mean"], stats["seq_std"], stats["seq_seen"], clip)
    static = encode(windows.static, stats["static_mean"], stats["static_std"], stats["static_seen"], clip)
    return (
        torch.from_numpy(seq),
        torch.from_numpy(static),
        torch.from_numpy(windows.metro),
        torch.from_numpy(windows.y),
    )


# raw head values become sorted quantiles: the median is free, every other
# quantile is the median plus or minus a running sum of softplus steps
def monotone(raw):
    median = raw[..., MEDIAN : MEDIAN + 1]
    below = F.softplus(raw[..., :MEDIAN]).flip(-1).cumsum(-1).flip(-1)
    above = F.softplus(raw[..., MEDIAN + 1 :]).cumsum(-1)
    return torch.cat([median - below, median, median + above], dim=-1)


# shared head: outputs are in standardized target units per horizon and are
# mapped back with the fitting set's location and scale, kept as buffers so
# a saved state dict carries them
class QuantileNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.register_buffer("y_loc", torch.zeros(N_HORIZONS))
        self.register_buffer("y_scale", torch.ones(N_HORIZONS))

    def set_target_stats(self, loc, scale):
        self.y_loc.copy_(torch.as_tensor(loc, dtype=torch.float32))
        self.y_scale.copy_(torch.as_tensor(scale, dtype=torch.float32))

    def quantiles(self, raw):
        q = monotone(raw.view(-1, N_HORIZONS, N_QUANTILES))
        return self.y_loc.view(1, -1, 1) + self.y_scale.view(1, -1, 1) * q


# the input widths default to the feature lists, resolved when the model is
# built rather than when the class is defined. bound as a default argument they
# went stale the moment anything changed SEQ_FEATURES, which is exactly what an
# ablation does, and the model then read the wrong number of channels
def _widths(n_seq, n_static):
    return (2 * len(SEQ_FEATURES) if n_seq is None else n_seq,
            2 * len(STATIC_FEATURES) if n_static is None else n_static)


class WindowMLP(QuantileNet):
    def __init__(self, n_metros, window=spec.WINDOW, n_seq=None, n_static=None, embed=EMBED, hidden=HIDDEN_MLP):
        super().__init__()
        n_seq, n_static = _widths(n_seq, n_static)
        self.embed = nn.Embedding(n_metros, embed)
        n_in = window * n_seq + n_static + embed
        self.net = nn.Sequential(
            nn.Linear(n_in, hidden[0]),
            nn.ReLU(),
            nn.Linear(hidden[0], hidden[1]),
            nn.ReLU(),
            nn.Linear(hidden[1], N_HORIZONS * N_QUANTILES),
        )

    def forward(self, seq, static, metro):
        x = torch.cat([seq.flatten(1), static, self.embed(metro)], dim=1)
        return self.quantiles(self.net(x))


class SeqGRU(QuantileNet):
    def __init__(self, n_metros, n_seq=None, n_static=None, embed=EMBED, hidden=HIDDEN_GRU):
        super().__init__()
        n_seq, n_static = _widths(n_seq, n_static)
        self.embed = nn.Embedding(n_metros, embed)
        self.gru = nn.GRU(n_seq, hidden, batch_first=True)
        self.head = nn.Linear(hidden + n_static + embed, N_HORIZONS * N_QUANTILES)

    def forward(self, seq, static, metro):
        _, state = self.gru(seq)
        x = torch.cat([state[-1], static, self.embed(metro)], dim=1)
        return self.quantiles(self.head(x))


# pinball loss over every horizon and quantile. pred is (batch, horizons,
# quantiles), y is (batch, horizons) with nan where the outcome is missing;
# those cells drop out of both the sum and the count
def pinball_loss(pred, y):
    valid = ~torch.isnan(y)
    target = torch.where(valid, y, torch.zeros_like(y)).unsqueeze(-1)
    diff = target - pred
    taus = torch.tensor(spec.QUANTILES, dtype=pred.dtype, device=pred.device)
    loss = torch.maximum(taus * diff, (taus - 1.0) * diff) * valid.unsqueeze(-1)
    return loss.sum() / (valid.sum() * N_QUANTILES).clamp(min=1)

# fhfa's index as each quarterly release printed it, from alfred's archive
# (scripts/download_fhfa_vintages.py), so a backtest can read prices the way a
# forecaster had them. fhfa revises past quarters as later sales come in: a
# quarter as first printed differs from today's by a median of about 1 percent.
#
# a forecast at origin t reads the release that first printed t, and a model
# refitted for year Y learns outcomes as printed by the release that first
# printed the last quarter of Y - 1. scoring keeps today's index as the truth.
# the archive starts with the 2013-05 release, so earlier origins read that
# one, the oldest there is. a metro is covered only when alfred carries its
# own code's series through the latest release; the rest, new metros and
# renumbered ones whose archive is a former county set, keep today's index

import numpy as np
import pandas as pd

from loop import nets, spec

PATH = spec.REPO_ROOT / "data" / "raw" / "fhfa_vintages" / "vintages.csv"
PRICE = ("hpi_qoq", "hpi_yoy")


class Vintages:
    def __init__(self, table):
        table = table.assign(cbsa_code=table["cbsa_code"].astype(str))
        own = table[table["series_id"] == "ATNHPIUS" + table["cbsa_code"] + "Q"].copy()
        own["quarter"] = pd.PeriodIndex(pd.to_datetime(own["date"]), freq="Q").astype(str)
        self.releases = sorted(own["realtime_start"].unique())
        latest = own[own["realtime_end"] == "9999-12-31"]
        newest = latest.groupby("cbsa_code")["quarter"].max()
        last = spec.to_period(latest["quarter"].max()) - 1
        self.metros = sorted(newest[newest.map(spec.to_period) >= last].index)
        self.table = own[own["cbsa_code"].isin(self.metros)]
        printed = self.table.groupby("quarter")["realtime_start"].min()
        self.first = {q: r for q, r in printed.items()}
        self._grids = {}

    @classmethod
    def load(cls, path=PATH):
        return cls(pd.read_csv(path, dtype={"cbsa_code": str}))

    # the release a forecaster at origin t had: the first to print t, or the
    # oldest release for an origin the archive predates
    def release_for(self, quarter):
        return self.first.get(str(quarter), self.releases[0] if str(quarter) < min(self.first) else None)

    # log index as printed by one release, metros by quarters
    def log_index(self, release):
        if release not in self._grids:
            rows = self.table[(self.table["realtime_start"] <= release) & (self.table["realtime_end"] >= release)]
            grid = rows.pivot(index="cbsa_code", columns="quarter", values="value")
            self._grids[release] = np.log(grid.reindex(columns=sorted(grid.columns)))
        return self._grids[release]

    def growth(self, release):
        grid = self.log_index(release)
        return {"hpi_qoq": grid.diff(1, axis=1), "hpi_yoy": grid.diff(4, axis=1)}


def _origins_by_release(vint, origins):
    out = {}
    for q in np.unique(origins):
        release = vint.release_for(q)
        if release is not None:
            out.setdefault(release, []).append(q)
    return out


# each sample's price channels replaced by the release its origin had, over
# the whole window, for covered metros. everything else in the window is left
def overlay_windows(windows, vint):
    window = windows.seq.shape[1]
    channels = {name: nets.SEQ_FEATURES.index(name) for name in PRICE}
    covered = np.isin(windows.codes, vint.metros)
    for release, quarters in _origins_by_release(vint, windows.origins).items():
        growth = vint.growth(release)
        columns = list(growth["hpi_qoq"].columns)
        position = {q: i for i, q in enumerate(columns)}
        rows = np.nonzero(np.isin(windows.origins, quarters) & covered)[0]
        if rows.size == 0:
            continue
        codes = windows.codes[rows]
        row_of = {c: i for i, c in enumerate(growth["hpi_qoq"].index)}
        metro_pos = np.array([row_of.get(c, -1) for c in codes])
        ends = np.array([position.get(q, -1) for q in windows.origins[rows]])
        ok = (metro_pos >= 0) & (ends >= 0)
        rows, metro_pos, ends = rows[ok], metro_pos[ok], ends[ok]
        steps = ends[:, None] - (window - 1) + np.arange(window)[None, :]
        inside = steps >= 0
        for name, channel in channels.items():
            values = growth[name].to_numpy()
            taken = values[metro_pos[:, None], np.clip(steps, 0, None)]
            windows.seq[rows, :, channel] = np.where(inside, taken, np.nan).astype(np.float32)
    return windows


# the classical models' price inputs at each origin, from the same release:
# the eight quarterly lags, the running mean, the national mean of yearly
# growth across the covered metros, and the two growth columns themselves
def overlay_dataset(data, vint, lags=8):
    data = data.copy()
    covered = data["cbsa_code"].astype(str).isin(vint.metros).to_numpy()
    for release, quarters in _origins_by_release(vint, data["quarter"].astype(str).to_numpy()).items():
        growth = vint.growth(release)
        qoq, yoy = growth["hpi_qoq"], growth["hpi_yoy"]
        running = qoq.T.expanding().mean().T
        national = yoy.mean(axis=0)
        rows = np.nonzero(data["quarter"].astype(str).isin(quarters).to_numpy() & covered)[0]
        if rows.size == 0:
            continue
        codes = data["cbsa_code"].astype(str).to_numpy()[rows]
        at = data["quarter"].astype(str).to_numpy()[rows]
        stack = qoq.stack(future_stack=True)
        for i in range(lags):
            back = [str(spec.to_period(q) - i) for q in at]
            data.loc[data.index[rows], f"lag{i}"] = stack.reindex(list(zip(codes, back))).to_numpy()
        data.loc[data.index[rows], "hpi_qoq"] = stack.reindex(list(zip(codes, at))).to_numpy()
        data.loc[data.index[rows], "hpi_yoy"] = yoy.stack(future_stack=True).reindex(list(zip(codes, at))).to_numpy()
        data.loc[data.index[rows], "qoq_mean"] = running.stack(future_stack=True).reindex(list(zip(codes, at))).to_numpy()
        data.loc[data.index[rows], "national_yoy"] = national.reindex(at).to_numpy()
    return data


# growth from each origin to origin + horizon as one release printed it, one
# value per row, nan where the metro is not covered or the release did not
# print both ends
def printed_growth(vint, release, codes, origins, horizons):
    stack = vint.log_index(release).stack(future_stack=True)
    codes = np.asarray(codes).astype(str)
    origins = np.asarray(origins).astype(str)
    horizons = np.asarray(horizons).astype(int)
    start = stack.reindex(list(zip(codes, origins))).to_numpy(dtype=float)
    ahead = [str(spec.to_period(q) + int(h)) for q, h in zip(origins, horizons)]
    end = stack.reindex(list(zip(codes, ahead))).to_numpy(dtype=float)
    out = end - start
    out[~np.isin(codes, vint.metros)] = np.nan
    return out


# the release a model for year Y learns from: the first to print Y - 1's
# fourth quarter, or the oldest one for a year the archive predates
def release_for_refit(vint, year):
    return vint.release_for(f"{year - 1}Q4")

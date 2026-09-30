import unittest

import numpy as np
import pandas as pd

from loop import backtest, nets, spec, vintages


def rows(code, series, values, start_quarter, release, until="9999-12-31"):
    quarters = pd.period_range(start_quarter, periods=len(values), freq="Q")
    return pd.DataFrame({"cbsa_code": code, "series_id": series, "date": [str(q.start_time.date()) for q in quarters],
                         "value": values, "realtime_start": release, "realtime_end": until})


# two releases. the first prints 2019Q1 to 2020Q1 with the last quarter at
# 110, the second revises it to 120 and adds 2020Q2. metro 10000 is its own
# series through the latest release; 20000 is only a former code's series,
# and 30000's own series stopped a year early
def archive():
    first = rows("10000", "ATNHPIUS10000Q", [100, 101, 102, 104, 110], "2019Q1", "2020-05-20", "2020-08-19")
    second = rows("10000", "ATNHPIUS10000Q", [100, 101, 102, 104, 120, 121], "2019Q1", "2020-08-20")
    former = rows("20000", "ATNHPIUS19999Q", [100, 101, 102, 104, 110, 111], "2019Q1", "2020-08-20")
    stopped = rows("30000", "ATNHPIUS30000Q", [100, 101], "2019Q1", "2020-08-20")
    return vintages.Vintages(pd.concat([first, second, former, stopped], ignore_index=True))


class TestTheArchive(unittest.TestCase):
    def test_only_a_metros_own_series_through_the_latest_release_is_covered(self):
        self.assertEqual(archive().metros, ["10000"])

    def test_an_origin_reads_the_release_that_first_printed_it(self):
        vint = archive()
        self.assertEqual(vint.release_for("2020Q1"), "2020-05-20")
        self.assertEqual(vint.release_for("2020Q2"), "2020-08-20")
        # older than the archive: the oldest release there is
        self.assertEqual(vint.release_for("2010Q1"), "2020-05-20")
        self.assertIsNone(vint.release_for("2021Q1"))

    def test_a_release_prints_its_own_values(self):
        vint = archive()
        self.assertAlmostEqual(np.exp(vint.log_index("2020-05-20").loc["10000", "2020Q1"]), 110)
        self.assertAlmostEqual(np.exp(vint.log_index("2020-08-20").loc["10000", "2020Q1"]), 120)

    # growth as one release printed it: 10000 from 104 to 110 in the first
    # release; the uncovered metro gets nothing, so today's value stands
    def test_training_outcomes_come_from_the_refits_release(self):
        vint = archive()
        growth = vintages.printed_growth(vint, "2020-05-20", ["10000", "20000"], ["2019Q4", "2019Q4"], [1, 1])
        self.assertAlmostEqual(growth[0], np.log(110 / 104))
        self.assertTrue(np.isnan(growth[1]))


class TestTheOverlay(unittest.TestCase):
    def panel(self):
        quarters = [str(q) for q in pd.period_range("2016Q1", "2020Q2", freq="Q")]
        out = []
        for code in ("10000", "20000"):
            hpi = np.linspace(80, 125, len(quarters))
            frame = pd.DataFrame({"cbsa_code": code, "quarter": quarters, "hpi": hpi})
            out.append(frame)
        panel = pd.concat(out, ignore_index=True)
        panel["log_hpi"] = np.log(panel["hpi"])
        panel["hpi_qoq"] = panel.groupby("cbsa_code")["log_hpi"].diff(1)
        panel["hpi_yoy"] = panel.groupby("cbsa_code")["log_hpi"].diff(4)
        return panel

    def test_the_window_at_an_origin_reads_that_origins_release(self):
        vint = archive()
        channel = nets.SEQ_FEATURES.index("hpi_qoq")
        windows = nets.build_windows(self.full(self.panel()), window=4, min_history=1)
        before = windows.seq.copy()
        vintages.overlay_windows(windows, vint)
        at = np.nonzero((windows.codes == "10000") & (windows.origins == "2020Q1"))[0][0]
        self.assertAlmostEqual(float(windows.seq[at, -1, channel]), np.log(110 / 104), places=6)
        # the uncovered metro keeps today's values
        other = np.nonzero((windows.codes == "20000") & (windows.origins == "2020Q1"))[0][0]
        np.testing.assert_array_equal(windows.seq[other], before[other])

    def test_the_classical_inputs_read_the_same_release(self):
        vint = archive()
        data = pd.DataFrame({"cbsa_code": ["10000", "20000"], "quarter": ["2020Q1", "2020Q1"], "horizon": 1,
                             "lag0": 0.0, "lag1": 0.0, "hpi_qoq": 0.0, "hpi_yoy": 0.0, "qoq_mean": 0.0,
                             "national_yoy": 0.0})
        out = vintages.overlay_dataset(data, vint, lags=2)
        self.assertAlmostEqual(out.loc[0, "lag0"], np.log(110 / 104))
        self.assertAlmostEqual(out.loc[0, "lag1"], np.log(104 / 102))
        self.assertAlmostEqual(out.loc[0, "hpi_yoy"], np.log(110 / 100))
        self.assertAlmostEqual(out.loc[0, "qoq_mean"], np.log(110 / 100) / 4)
        self.assertEqual(out.loc[1, "lag0"], 0.0)

    # every column the window builder reads, filled so the price channels are
    # the only thing that matters
    def full(self, panel):
        for column in spec.PANEL_COLUMNS:
            if column not in panel.columns:
                panel[column] = 0.0
        return panel


if __name__ == "__main__":
    unittest.main()

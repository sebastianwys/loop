# a red test, the panel side of the gap
# the map records in tests/redtest_former_code.py.
# run_tests.py discovers test*.py, so this one runs on its own, from ml/:
#   .venv/bin/python -m unittest tests.redtest_former_code -v

import unittest

import numpy as np
import pandas as pd

from loop import panel, spec

# settled 2026-09-18 (commit 82718e9): a metro omb renumbered without redrawing
# it keeps its history under its current code. cleveland is 17410 today and
# was 17460 on the delineations pep's 2010 to 2019 estimates and the 2014 to
# 2023 permit counts were filed under
CLEVELAND, CLEVELAND_OLD = "17410", "17460"

# a 2014 annual value is known from the first quarter of 2015
QUARTER = "2015Q1"
# except permits: bps posts its annual files in may, so the lag table
# (spec.PUBLISHED_IN_QUARTER, 2026-09-29) reads 2014 permits from 2015Q2. this
# test was written under the old one quarter rule
PERMITS_QUARTER = "2015Q2"


# a metric's value for a metro-year, filed under its current code or its
# former one, whichever the collector used
def filed(source, metric, year):
    frame = pd.read_csv(spec.RAW_DIR / source / "metrics.csv", dtype={"cbsa_code": str, "period": str})
    rows = frame[frame["cbsa_code"].isin([CLEVELAND, CLEVELAND_OLD])
                 & (frame["metric"] == metric) & (frame["period"] == str(year))]
    return float(rows["value"].iloc[0]) if len(rows) else None


@unittest.skipUnless((spec.RAW_DIR / "fhfa" / "hpi_master.csv").exists(), "raw files not on this machine")
class TestARenumberedMetroKeepsItsHistory(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frame = panel.build()
        cls.row = frame[(frame["cbsa_code"] == CLEVELAND) & (frame["quarter"] == QUARTER)].iloc[0]
        cls.permits_row = frame[(frame["cbsa_code"] == CLEVELAND) & (frame["quarter"] == PERMITS_QUARTER)].iloc[0]

    # the model reads all three as static features, so a null here is a
    # cleveland window with its population and permits blanked
    def test_2015q1_population_growth_is_the_2014_over_2013_estimate(self):
        earlier, later = filed("pep", "pop_estimate", 2013), filed("pep", "pop_estimate", 2014)
        self.assertEqual((earlier, later), (2067100.0, 2067356.0))
        self.assertFalse(np.isnan(self.row["pop_growth"]), "pep estimated cleveland in 2013 and 2014 and the panel reads null")
        self.assertAlmostEqual(self.row["pop_growth"], np.log(later / earlier), places=9)

    def test_2015q1_domestic_migration_rate_is_the_2014_estimate(self):
        rate = filed("pep", "domestic_migration_rate", 2014)
        self.assertEqual(rate, -3.42)
        self.assertEqual(self.row["domestic_migration_rate"], rate)

    def test_2015q2_permits_per_1000_are_the_2014_permits_over_the_2014_population(self):
        permits, people = filed("bps", "permits_units", 2014), filed("pep", "pop_estimate", 2014)
        self.assertEqual(permits, 2900.0)
        self.assertAlmostEqual(self.permits_row["permits_per_1000"], permits / people * 1000.0, places=9)


if __name__ == "__main__":
    unittest.main()

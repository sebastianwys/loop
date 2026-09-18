# a red test for the audit's irs finding. six of the seven closed 2026-09-18
# when the collector was re-run against the planning region crosswalk that
# landed after the last pull. one stays open and is not a stale artifact:
# 47930 waterbury-shelton is the naugatuck valley planning region alone, and
# naugatuck valley was assembled from towns in three counties, so no county
# total the irs published before 2022 belongs to it. irs has no town level
# file, so this one cannot be fixed by arithmetic, only by a town crosswalk
# and a source that publishes towns. the note at CONNECTICUT in the collector
# measures what the other six cost. run it deliberately, it is not discovered
# by run_tests.py:
#   ml/.venv/bin/python -m unittest tests.redtest_irs_connecticut -v

import unittest
from pathlib import Path

import pandas as pd

from bot.collectors import irs

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"

# the seven cbsa codes whose ground is a connecticut planning region. irs
# reports ct counties for the older filing year pairs, the july 2023
# delineation carries planning regions only, so the older pairs never join
CONNECTICUT_CODES = ["14860", "25540", "35300", "35980", "39480", "45860", "47930"]


def shipped():
    return pd.read_csv(RAW / "irs" / "metrics.csv", dtype={"cbsa_code": str, "period": str})


class TestConnecticutKeepsItsFilingYears(unittest.TestCase):
    def setUp(self):
        path = RAW / "irs" / "metrics.csv"
        if not path.exists():
            self.skipTest("irs metrics.csv is not on disk")
        self.frame = shipped()

    # abilene is the control: a code whose counties never moved
    def test_abilene_carries_the_whole_run_of_filing_years(self):
        periods = self.frame[self.frame.cbsa_code == "10180"].period.nunique()
        self.assertGreaterEqual(periods, 10)

    def test_no_code_is_short_only_because_its_counties_were_renamed(self):
        per_code = self.frame.groupby("cbsa_code").period.nunique()
        usual = int(per_code.median())
        short = sorted(per_code[per_code < usual].index)
        self.assertEqual(short, [], f"short against the usual {usual} filing years")

    def test_hartford_carries_the_years_irs_published_for_its_counties(self):
        periods = sorted(set(self.frame[self.frame.cbsa_code == "25540"].period))
        self.assertGreaterEqual(len(periods), 10, f"hartford has {periods}")


class TestTheCrosswalkCarriesConnecticut(unittest.TestCase):
    # the delineation names planning regions, so a county fips has to reach the
    # cbsa its planning region belongs to, the same way bea already does it
    def test_a_connecticut_county_reaches_its_cbsa(self):
        crosswalk = pd.DataFrame({
            "county_fips": ["09110", "48059"],
            "cbsa_code": ["25540", "10180"],
        })
        mapped = irs.add_connecticut(crosswalk)
        hartford = set(mapped[mapped.county_fips == "09003"].cbsa_code)
        self.assertEqual(hartford, {"25540"})

    def test_a_county_the_delineation_already_names_is_left_alone(self):
        crosswalk = pd.DataFrame({"county_fips": ["09003"], "cbsa_code": ["99999"]})
        mapped = irs.add_connecticut(crosswalk)
        self.assertEqual(len(mapped), 1)
        self.assertEqual(set(mapped.cbsa_code), {"99999"})


if __name__ == "__main__":
    unittest.main()

# a red test. run_tests.py discovers test*.py, so this one runs on its own:
#   ml/.venv/bin/python -m unittest tests.redtest_msa_crosswalk -v

import collections
import csv
import sys
import unittest
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import download_census as dc

BASE_DIR = Path(__file__).parent.parent
VINTAGE_MEMBERSHIP = BASE_DIR / "data" / "raw" / "gazetteer" / "cbsa_counties_by_vintage.csv"
MERGED = BASE_DIR / "data" / "integrated" / "hpi_census_merged.csv"
ACS = BASE_DIR / "data" / "raw" / "census" / "acs_5yr_combined.csv"

# the four metros omb renumbered without moving a county between the 2014 or
# 2019 vintage and now. measured below against the delineation rather than
# taken from a name: each old code carries exactly the county set the current
# code carries today, in every vintage the delineation lists it
RENUMBERED = {
    "19380": "19430",  # dayton -> dayton-kettering-beavercreek, oh
    "39100": "28880",  # poughkeepsie-newburgh-middletown -> kiryas joel-poughkeepsie-newburgh, ny
    "39140": "39150",  # prescott -> prescott valley-prescott, az
    "45540": "48680",  # the villages -> wildwood-the villages, fl
}


def membership():
    out = collections.defaultdict(set)
    with open(VINTAGE_MEMBERSHIP) as f:
        for row in csv.DictReader(f):
            out[(row["vintage"], row["cbsa_code"].strip())].add(row["county_fips"].strip())
    return out


def acs_codes():
    census = pd.read_csv(ACS, dtype={dc.MSA_COL: str, dc.DIV_COL: str, "geo_code": str, "parent_cbsa": str})
    codes = census["geo_code"] if "geo_code" in census.columns else census[dc.MSA_COL]
    seen = collections.defaultdict(set)
    for code, year in zip(codes.astype(str), census["year"]):
        seen[str(year)].add(code)
    return seen


# a division that changed code without changing counties is crosswalked, so the
# older vintages join. a metro that did the same is not: there is no msa table
class TestARenumberedMetroJoinsOnItsCurrentCode(unittest.TestCase):
    def test_the_renamed_metro_is_tagged_with_the_code_the_merge_joins_on(self):
        df = pd.DataFrame({"NAME": ["Dayton, OH Metro Area"], dc.MSA_COL: ["19380"]})
        out = dc.tag_geography(df, "msa")
        self.assertEqual(out.geo_code.tolist(), ["19430"],
                         "the 2014 vintage joins on a code fhfa stopped using")

    # the control: a metro that was never renumbered keeps its own code
    def test_a_metro_that_never_moved_keeps_its_own_code(self):
        df = pd.DataFrame({"NAME": ["Abilene, TX Metro Area"], dc.MSA_COL: ["10180"]})
        self.assertEqual(dc.tag_geography(df, "msa").geo_code.tolist(), ["10180"])


# what makes the table checkable rather than a list of names somebody matched
# by eye. a pair that fails either of these is not the same place
class TestTheRenumberedPairsAreTheSamePlace(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mem = membership()
        cls.acs = acs_codes()

    def test_each_old_code_carries_the_current_county_set(self):
        for old, new in RENUMBERED.items():
            current = self.mem[("2024", new)]
            self.assertTrue(current, new)
            for vintage in ("2014", "2019"):
                counties = self.mem[(vintage, old)]
                if not counties:
                    continue
                self.assertEqual(counties, current, f"{old} -> {new} in {vintage}")

    # both codes in one vintage would land two rows on one join key, which
    # tag_geography already refuses. none of these four ever does
    def test_no_vintage_carries_both_codes(self):
        for old, new in RENUMBERED.items():
            for vintage in ("2014", "2019", "2024"):
                self.assertFalse(old in self.acs[vintage] and new in self.acs[vintage],
                                 f"{old} and {new} both in {vintage}")

    # the whole point: the metro-years the merged csv does not have
    def test_the_crosswalk_recovers_five_of_the_thirty_three_missing_metro_years(self):
        merged = pd.read_csv(MERGED, dtype={"cbsa_code": str})
        have = set(zip(merged.cbsa_code, merged.year))
        codes, years = sorted(merged.cbsa_code.unique()), sorted(merged.year.unique())
        gaps = [(c, y) for c in codes for y in years if (c, y) not in have]
        self.assertEqual(len(gaps), 33)
        recovered = [(c, y) for c, y in gaps
                     if any(new == c and old in self.acs[str(y)] for old, new in RENUMBERED.items())]
        self.assertEqual(sorted(recovered),
                         [("19430", 2014), ("28880", 2019), ("39150", 2014),
                          ("48680", 2014), ("48680", 2019)])


if __name__ == "__main__":
    unittest.main()

# a red test. run from the project root:
#   ml/.venv/bin/python -m unittest tests/redtest_sentinel_universe.py -v
#
# census marks a suppressed estimate with a large negative sentinel, and
# load_merged masks it in every column NUMERIC names. adults_25_plus joined on
# 2026-09-16 as the degree share's denominator, after NUMERIC was written, and
# NUMERIC does not name it. year_record divides by it through ratio, which
# guards only a zero, so a suppressed universe publishes -0.0 where the page
# should read a blank. nothing ships a sentinel there today: the smallest
# adults_25_plus in the merged csv is 38,327
#
# the fixture is the build suite's own, with one cell of abilene's 2019 row
# set to the sentinel census prints, built into a temporary folder

import json
import math
import unittest
from pathlib import Path

import pandas as pd

from bot import build_map_data as bm
from tests.test_build_map_data import MERGED, MERGED_COLS, BuildCase

CENSUS_SENTINEL = -666666666

# every merged column the year panel, the growth rates and the price to income
# ratio read
PANEL_COLUMNS = [
    "avg_index_nsa", "median_income", "total_pop", "median_age", "adults_25_plus",
    "bachelors_count", "masters_count", "total_occupied_units", "owner_occupied_units",
    "median_home_value", "homeownership_rate",
]


class TestNoSentinelReachesAPublishedNumber(BuildCase):
    # abilene's merged rows with one 2019 cell set to the sentinel
    def merged_with(self, column):
        rows = [list(row) for row in MERGED]
        for row in rows:
            if row[0] == "10180" and row[4] == 2019:
                row[MERGED_COLS.index(column)] = CENSUS_SENTINEL
        path = Path(self.tmp.name) / f"merged_{column}.csv"
        pd.DataFrame(rows, columns=MERGED_COLS).to_csv(path, index=False)
        return path

    # abilene as a first build of its own file, so no build is measured
    # against another one by the loss guard
    def abilene(self, column):
        out = Path(self.tmp.name) / f"metros_{column}.json"
        payload = json.loads(bm.build(out_path=out, paths=dict(self.paths, merged=self.merged_with(column))).read_text())
        return self.metro(payload, "10180")

    def test_a_suppressed_universe_publishes_null_not_minus_zero(self):
        abilene = self.abilene("adults_25_plus")
        share = abilene["years"]["2019"]["degree_share"]
        self.assertIsNone(share, f"a suppressed universe published {json.dumps(share)} as abilene's 2019 degree share")
        # the other years keep theirs
        self.assertEqual(abilene["years"]["2014"]["degree_share"], 0.1846)

    def test_load_merged_masks_the_universe(self):
        merged = bm.load_merged(self.merged_with("adults_25_plus"))
        cell = merged.loc[(merged["cbsa_code"] == "10180") & (merged["year"] == 2019), "adults_25_plus"].iloc[0]
        self.assertTrue(pd.isna(cell), f"adults_25_plus kept the census sentinel {cell}")

    # the invariant over every column the panels read: a sentinel in any one
    # of them leaves no negative number, -0.0 included, in abilene's 2019
    # panel, its 2019 price to income ratio or its growth rates, all of which
    # are positive in the fixture
    def test_a_sentinel_in_any_column_the_panels_read_publishes_no_number(self):
        leaked = {}
        for column in PANEL_COLUMNS:
            abilene = self.abilene(column)
            numbers = {**abilene["years"]["2019"], "ptir_2019": abilene["ptir"]["2019"], **abilene["growth"]}
            bad = {k: v for k, v in numbers.items()
                   if isinstance(v, float) and math.copysign(1.0, v) < 0}
            if bad:
                leaked[column] = bad
        self.assertEqual(leaked, {}, "a census sentinel reached a published number")

    # the control, green today: a column NUMERIC names is masked
    def test_a_suppressed_age_is_null(self):
        self.assertIsNone(self.abilene("median_age")["years"]["2019"]["age"])


if __name__ == "__main__":
    unittest.main()

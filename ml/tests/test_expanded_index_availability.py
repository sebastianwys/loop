"""the backtest reads fhfa's expanded data index only where fhfa had published it.

fhfa's technical note for the 2026q1 release: "Starting with the release of
the 2026Q1 FHFA House Price Index report, ... FHFA will begin publishing
quarterly Expanded-Data house price indexes for 410 metropolitan areas, up
from 50." this repo's pulls of hpi_exp_metro.txt before 2026 hold 50 metros,
1991q1 to 2025q4, and the pull the panel is built from holds 410. panel.build
merges the file onto every metro quarter since 1991, so for the other 360
metros the two columns carry values at origins where no forecaster could have
read them.

the shipped forecast reads the index for all 410 metros because fhfa
publishes it now, and everything scored on the past reads
spec.realtime(panel), which masks the 360 before 2026q1. so this test holds
the scored view to the rule and keeps a control that the shipped panel still
carries the index.

one boundary this test does not cover. the same note says the expanded data
metro indexes "began in 2012 for 25 areas, expanding to 50 areas in 2018", so
strictly none of the 50 was published at the fitting block's origins either.
this test holds the panel to the other 360 metros.
"""

import unittest

import pandas as pd

from loop import panel, spec

# the first fhfa release that carries the expanded index for all 410 metros.
# its values are known from their own quarter the way every other fhfa value
# in the panel is, so the rule bites before this quarter
FIRST_RELEASE_WITH_410 = "2026Q1"

# the metros in hpi_exp_metro.txt as fhfa published it before 2026q1, from
# this repo's own pulls. regenerate with
#   git show 5f612b7:data/raw/fhfa/hpi_exp_metro.txt | cut -f1 | sort -u
PUBLISHED_BEFORE_2026 = frozenset({
    "11244", "11694", "12054", "12420", "12580", "14454", "15764", "16740", "16984", "17140",
    "17410", "18140", "19124", "19740", "19804", "22744", "23104", "26420", "26900", "27260",
    "28140", "29484", "29820", "31084", "33124", "33340", "33460", "33874", "34980", "35004",
    "35084", "35614", "36084", "36740", "37964", "38060", "38300", "38900", "39300", "40140",
    "40900", "41180", "41700", "41740", "41940", "42644", "45294", "47260", "47664", "47764",
})

# the panel columns that come out of the expanded file and reach a model
EXPANDED_INPUTS = ("hpi_exp_yoy", "hpi_rstderr")

# the first origin whose outcomes can land in the test block, at eight quarters
FIRST_TEST_ORIGIN = spec.shift_quarter(spec.TEST_START, -max(spec.HORIZONS))


@unittest.skipUnless((spec.RAW_DIR / "fhfa" / "hpi_exp_metro.txt").exists(), "raw fhfa files not on this machine")
class TestTheBacktestReadsOnlyWhatFhfaHadPublished(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shipped = panel.build()
        cls.frame = spec.realtime(cls.shipped)
        quarter = pd.PeriodIndex(cls.frame["quarter"], freq="Q")
        cls.unpublished = ~cls.frame["cbsa_code"].isin(PUBLISHED_BEFORE_2026) & (quarter < spec.to_period(FIRST_RELEASE_WITH_410))
        cls.scored = quarter >= spec.to_period(FIRST_TEST_ORIGIN)

    # the control. the 50 are all in the panel under the same codes, so a pass
    # below cannot come from a renumbered metro or a panel that lost them
    def test_the_metros_fhfa_published_before_2026_are_all_in_the_panel(self):
        self.assertEqual(sorted(PUBLISHED_BEFORE_2026 - set(self.frame["cbsa_code"])), [])
        self.assertGreater(int((~self.frame["cbsa_code"].isin(PUBLISHED_BEFORE_2026)).sum()), 0)

    def test_no_model_input_carries_a_value_fhfa_had_not_published_by_its_quarter(self):
        read = [column for column in EXPANDED_INPUTS if column in spec.FEATURES]
        for column in read:
            with self.subTest(column=column):
                carried = self.frame[self.unpublished & self.frame[column].notna()]
                at_test = int((self.scored & self.unpublished & self.frame[column].notna()).sum())
                self.assertEqual(
                    len(carried), 0,
                    f"{column} carries {len(carried)} values for {carried['cbsa_code'].nunique()} metros fhfa first "
                    f"published in 2026, at quarters {carried['quarter'].min() if len(carried) else '-'} to "
                    f"{carried['quarter'].max() if len(carried) else '-'}; {at_test} of them sit at origins from "
                    f"{FIRST_TEST_ORIGIN}, where the published test scores read them",
                )


    # the control: the shipped forecast reads the index for all 410 metros,
    # history included, because fhfa publishes it now
    def test_the_shipped_panel_still_carries_the_whole_index(self):
        for column in EXPANDED_INPUTS:
            with self.subTest(column=column):
                self.assertGreater(int((self.unpublished & self.shipped[column].notna()).sum()), 40000)


if __name__ == "__main__":
    unittest.main()

# a red test for the audit's fred_annual finding. CLOSED 2026-09-18, and the
# question it was left open on is answered rather than dodged. the calendar is
# the fullest year in the file counted in MONTHS, not rows: a daily, weekly or
# monthly series fills twelve months of a whole year, a quarterly one four, an
# annual one one, so one denominator reads every cadence and a sparse file gets
# a sparse calendar instead of losing every year to a two row one. the share is
# the 0.75 already settled and no new number was decided. the only caller is the
# national mortgage rate at 2014, 2019 and 2024, each holding all twelve
# months, so no published value moved. run it deliberately, it is not
# discovered by run_tests.py:
#   ml/.venv/bin/python -m unittest tests.redtest_fred_completeness -v

import unittest

import pandas as pd

from bot import build_map_data


# a weekly series, 52 observations a year. 2019 is whole, 2024 holds thirteen
# weeks, which is a quarter of a year presented as a year
def weekly(years):
    rows = []
    for year, weeks in years.items():
        for w in range(weeks):
            rows.append({"date": f"{year}-{(w // 4) + 1:02d}-{(w % 4) * 7 + 1:02d}", "value": float(w)})
    return pd.DataFrame(rows)


class TestAFredYearNeedsEnoughOfTheYear(unittest.TestCase):
    # the control: a whole year still averages
    def test_a_whole_year_is_a_year(self):
        frame = weekly({2019: 52, 2024: 52})
        self.assertIsNotNone(build_map_data.fred_annual(frame, 2019))
        self.assertIsNotNone(build_map_data.fred_annual(frame, 2024))

    # the control: the threshold is three quarters, so 39 of 52 holds
    def test_three_quarters_of_a_year_is_a_year(self):
        frame = weekly({2019: 52, 2024: 39})
        self.assertIsNotNone(build_map_data.fred_annual(frame, 2024))

    def test_a_quarter_of_a_year_is_not_a_year(self):
        frame = weekly({2019: 52, 2024: 13})
        self.assertIsNone(build_map_data.fred_annual(frame, 2024),
                          "13 of 52 weeks is not an annual mean")

    def test_a_truncated_file_does_not_publish_a_partial_mean(self):
        frame = weekly({2014: 52, 2019: 52, 2024: 8})
        self.assertIsNone(build_map_data.fred_annual(frame, 2024))

    # the rule is the one already decided for an annual mean, not a new number
    def test_the_threshold_is_the_one_the_builder_already_uses(self):
        self.assertEqual(build_map_data.MIN_YEAR_SHARE, 0.75)


if __name__ == "__main__":
    unittest.main()

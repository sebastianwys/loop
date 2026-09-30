# a red test. the page side of the same tile, its printed precision, is in
# web/src/lib/fedfunds.redtest.ts. run_tests.py discovers test*.py, so this
# one runs on its own, from the root:
#   ml/.venv/bin/python -m unittest tests.redtest_twelve_month_change -v

import json
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from bot import build_map_data as bm
from bot.collectors import fred, national

# the chip beside a tile says "over twelve months" and the build rounds a
# rate's change to two decimals, so a change is right when it lands within that
# rounding of the move it names
ROUNDING = 0.005 + 1e-9

# the upper limit of the fed funds target, one observation a day as fred
# publishes it. the september 2025 cut took effect on the 18th and the build
# runs on 2026-09-17, the middle of the newest month, the day the september
# 2026 hike took effect. september is not over, so the chip is for the twelve
# months to august, 3.75 less the 4.50 of a year before, a fall of 0.75
STEPS = [("2025-01-01", 4.50), ("2025-09-18", 4.25), ("2025-10-30", 4.00),
         ("2025-12-11", 3.75), ("2026-09-17", 4.00)]
BUILD_DAY = "2026-09-17"


def daily_target():
    days = pd.date_range(STEPS[0][0], BUILD_DAY, freq="D")
    values = pd.Series(float("nan"), index=days)
    for start, level in STEPS:
        values[values.index >= pd.Timestamp(start)] = level
    return [{"date": d.strftime("%Y-%m-%d"), "value": f"{v:.2f}"} for d, v in values.items()]


# where a series stood on a day: its newest reading on or before it
def level_on(rows, day):
    rows = rows.dropna(subset=["value"])
    known = rows[pd.to_datetime(rows["date"]) <= pd.Timestamp(day)]
    return float(known.sort_values("date")["value"].iloc[-1])


# the day the tile's value was read: the newest observation in the tile's month
def reading_day(rows, month):
    rows = rows.dropna(subset=["value"])
    return rows[rows["date"].str.startswith(month)]["date"].max()


def last_day(month):
    return pd.Period(month, freq="M").end_time.strftime("%Y-%m-%d")


# the fix taken on 2026-09-29: the chip is the change over the twelve months
# to change_month, the newest month the series has finished, that month's last
# reading less the same month's a year before. a same-day base, which this
# test first asked for, breaks the rule that the chip is the difference of two
# levels on the chart beside it
def finished_month_change(rows, month):
    before = pd.Period(month, freq="M") - 12
    return level_on(rows, last_day(month)) - level_on(rows, last_day(str(before)))


class TwelveMonthCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    # the csv the national collector writes, read back the way the build reads it
    def build_tile(self, observations, cut_to_month_end=True):
        frame = fred.parse_observations(observations)
        if cut_to_month_end:
            frame = national.month_end(frame)
        path = Path(self.tmp.name) / "indicators.csv"
        frame.assign(series_id="DFEDTARU")[national.COLUMNS].to_csv(path, index=False)
        written = bm.load_national(path)
        block = bm.national_block(None, written)
        return next(t for t in block["indicators"] if t["id"] == "fed_funds"), written

    def assertMeasuredOverTwelveMonths(self, tile, rows):
        read_on = reading_day(rows, tile["date"])
        self.assertEqual(tile["value"], level_on(rows, read_on))
        self.assertTheChangeIsForAFinishedMonth(tile, read_on)
        moved = finished_month_change(rows, tile["change_month"])
        self.assertLessEqual(
            abs(tile["change_12m"] - moved), ROUNDING,
            f"the chip reads {tile['change_12m']} for the twelve months to {tile['change_month']}, "
            f"where the target moved {moved:+.2f}")

    # measuring at change_month cannot see a month read partway through, since
    # level_on reads that month's newest reading the way the build did. so the
    # month itself is checked: the reading's own month when the reading fell
    # on its last day, an earlier month otherwise
    def assertTheChangeIsForAFinishedMonth(self, tile, read_on):
        if read_on == last_day(tile["date"]):
            self.assertEqual(tile["change_month"], tile["date"],
                             f"the reading of {read_on} finished {tile['date']}, and the chip is for "
                             f"{tile['change_month']}")
        else:
            self.assertLess(tile["change_month"], tile["date"],
                            f"the chip is for {tile['change_month']}, a month the reading of {read_on} "
                            f"has not finished")


class TestAChangeOverTwelveMonthsSpansTwelveMonths(TwelveMonthCase):
    # the collector keeps a daily series' last observation of each month, so
    # the newest month holds the build day's reading, which has not finished
    # september, and the chip is for august
    def test_a_chip_read_partway_through_a_month_is_for_the_month_before(self):
        tile, _ = self.build_tile(daily_target())
        self.assertMeasuredOverTwelveMonths(tile, fred.parse_observations(daily_target()))

    # and with every daily reading on disk the chip is still for august, month
    # end to month end, so the rule is the build's and not the collector's cut
    def test_with_every_daily_reading_on_disk_the_chip_is_still_for_august(self):
        tile, written = self.build_tile(daily_target(), cut_to_month_end=False)
        self.assertMeasuredOverTwelveMonths(tile, written)

    # the control: a month the series has finished pairs two month-end
    # readings, which are twelve months apart, and nothing here objects
    def test_a_finished_month_is_already_measured_over_twelve_months(self):
        through_august = [o for o in daily_target() if o["date"] < "2026-09-01"]
        tile, _ = self.build_tile(through_august)
        self.assertEqual((tile["value"], tile["date"]), (3.75, "2026-08"))
        self.assertMeasuredOverTwelveMonths(tile, fred.parse_observations(through_august))


# the shipped tile against the archive it was built from. the archive keeps a
# daily series' last reading of each month, so both ends of the change are rows
# in it and points on the chart
class TestTheShippedFedFundsTile(TwelveMonthCase):
    def test_the_published_change_spans_twelve_months_of_the_archive(self):
        payload = json.loads((bm.WEB_DATA_DIR / "metros.json").read_text())
        tile = next(t for t in payload["national"]["indicators"] if t["id"] == "fed_funds")
        archive = bm.load_national(bm.DEFAULT_PATHS["national"])
        rows = archive[archive["series_id"] == "DFEDTARU"]
        read_on = reading_day(rows, tile["date"])
        self.assertEqual(tile["value"], level_on(rows, read_on))
        self.assertTheChangeIsForAFinishedMonth(tile, read_on)
        moved = finished_month_change(rows, tile["change_month"])
        self.assertLessEqual(
            abs(tile["change_12m"] - moved), ROUNDING,
            f"the shipped chip reads {tile['change_12m']} for the twelve months to {tile['change_month']}, "
            f"where the archive moved {moved:+.2f}")


if __name__ == "__main__":
    unittest.main()

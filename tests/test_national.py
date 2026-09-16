import tempfile
import unittest
from pathlib import Path

import pandas as pd

from bot import build_map_data as bm
from bot import indicators
from bot.collectors import fred, national

# the mortgage rate file the existing national block is built from
FRED = pd.DataFrame({
    "date": ["2014-01-02", "2019-01-03", "2024-01-04", "2026-09-10"],
    "value": [4.5, 4.0, 6.6, 6.76],
})


def rows_csv(rows):
    return "series_id,date,value\n" + "".join(f"{s},{d},{v}\n" for s, d, v in rows)


# every month from count-1 back up to the newest, oldest first
def month_span(newest, count):
    return [bm.month_back(newest, back) for back in reversed(range(count))]


class NationalCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    # through the real loader, so a dot travels the same path it does in a build
    def frame(self, rows):
        path = Path(self.tmp.name) / "indicators.csv"
        path.write_text(rows_csv(rows))
        return bm.load_national(path)

    def grid(self, rows):
        return bm.monthly_grid(self.frame(rows))

    def months_for(self, indicator_id, rows):
        return bm.indicator_months(indicators.by_id(indicator_id), self.grid(rows))


class TestMonthlyGrid(NationalCase):
    # two observations in one month, out of order in the file
    def test_last_observation_in_a_month_wins(self):
        grid = self.grid([
            ("DGS10", "2026-08-20", "4.28"),
            ("DGS10", "2026-08-03", "4.11"),
            ("DGS10", "2026-07-31", "4.02"),
        ])
        self.assertEqual(grid["DGS10"], {"2026-07": 4.02, "2026-08": 4.28})

    # fred publishes a missing observation as a dot
    def test_dot_is_missing_not_zero(self):
        frame = self.frame([
            ("MORTGAGE30US", "2026-08-07", "6.58"),
            ("MORTGAGE30US", "2026-08-14", "."),
        ])
        self.assertTrue(pd.isna(frame["value"].iloc[1]))
        # the dot is the last row of the month, so the week before it stands
        self.assertEqual(bm.monthly_grid(frame)["MORTGAGE30US"], {"2026-08": 6.58})

    def test_a_month_of_nothing_but_dots_has_no_key(self):
        grid = self.grid([
            ("UNRATE", "2026-07-01", "4.2"),
            ("UNRATE", "2026-08-01", "."),
        ])
        self.assertEqual(grid["UNRATE"], {"2026-07": 4.2})

    def test_each_series_keeps_its_own_months(self):
        grid = self.grid([
            ("DGS1", "2026-08-31", "3.50"),
            ("EFFR", "2026-08-31", "4.33"),
        ])
        self.assertEqual(sorted(grid), ["DGS1", "EFFR"])
        self.assertEqual(grid["EFFR"]["2026-08"], 4.33)

    def test_month_back_crosses_the_year(self):
        self.assertEqual(bm.month_back("2026-01", 1), "2025-12")
        self.assertEqual(bm.month_back("2026-08", 12), "2025-08")
        self.assertEqual(bm.month_back("2026-03", 15), "2024-12")


class TestYearOverYear(NationalCase):
    # an index that rises exactly three percent over twelve months
    def test_three_percent_is_three_point_zero(self):
        span = month_span("2026-01", 13)
        rows = [("CPIAUCSL", f"{m}-01", f"{100.0 + 0.25 * i:.3f}") for i, m in enumerate(span)]
        rows[-1] = ("CPIAUCSL", "2026-01-01", "103.000")
        months = self.months_for("cpi", rows)
        self.assertEqual(months["2026-01"], 3.0)
        # the first month has nothing twelve months back
        self.assertIsNone(months.get("2025-01"))

    # the base month is missing, and the month before it must not stand in
    def test_a_twelve_month_gap_is_null_not_bridged(self):
        rows = [
            ("CPIAUCSL", "2025-01-01", "100.000"),
            ("CPIAUCSL", "2025-02-01", "."),
            ("CPIAUCSL", "2026-01-01", "102.000"),
            ("CPIAUCSL", "2026-02-01", "103.000"),
        ]
        months = self.months_for("cpi", rows)
        self.assertEqual(months["2026-01"], 2.0)
        self.assertIsNone(months.get("2026-02"))

    def test_a_fall_in_the_index_is_negative(self):
        rows = [("CPIAUCSL", "2025-06-01", "200.000"), ("CPIAUCSL", "2026-06-01", "198.000")]
        self.assertEqual(self.months_for("cpi", rows)["2026-06"], -1.0)

    def test_yoy_rounds_to_one_decimal(self):
        rows = [("PCEPILFE", "2025-06-01", "120.000"), ("PCEPILFE", "2026-06-01", "123.456")]
        self.assertEqual(self.months_for("core_pce", rows)["2026-06"], 2.9)


class TestSpread(NationalCase):
    ROWS = [
        ("DGS1", "2026-06-30", "3.80"),
        ("DGS1", "2026-07-31", "3.60"),
        ("DGS1", "2026-08-31", "3.50"),
        ("EFFR", "2026-06-30", "4.33"),
        ("EFFR", "2026-07-31", "4.33"),
    ]

    def test_spread_pairs_the_same_month(self):
        months = self.months_for("rate_path", self.ROWS)
        self.assertEqual(months["2026-06"], -0.53)
        self.assertEqual(months["2026-07"], -0.73)

    # august has no effr, so it is not paired with july's
    def test_missing_side_is_null(self):
        months = self.months_for("rate_path", self.ROWS)
        self.assertIsNone(months.get("2026-08"))
        self.assertEqual(sorted(months), ["2026-06", "2026-07"])

    def test_no_against_series_at_all_leaves_nothing(self):
        months = self.months_for("rate_path", [r for r in self.ROWS if r[0] == "DGS1"])
        self.assertEqual(months, {})


class TestRecord(NationalCase):
    def rate_rows(self, count=70, newest="2026-08"):
        return [("DGS10", f"{m}-15", f"{4.00 + 0.01 * i:.2f}")
                for i, m in enumerate(month_span(newest, count))]

    def record(self, indicator_id, rows):
        months = self.months_for(indicator_id, rows)
        return bm.indicator_record(indicators.by_id(indicator_id), months)

    # a tile and the chart drawn beside it read one series, so they read one
    # number. rounding the history to a decimal the tile does not use put the
    # shipped fed funds tile at 3.75 and its own chart at 3.8
    def test_level_value_is_as_published_and_the_history_matches_it(self):
        record = self.record("treasury_10y", self.rate_rows())
        self.assertEqual(record["date"], "2026-08")
        self.assertEqual(record["value"], 4.69)
        self.assertEqual(record["history"][-1], {"date": "2026-08", "value": 4.69})

    # a quarter point target is published as 3.75 and must stay 3.75
    def test_a_quarter_point_rate_survives_into_the_history(self):
        rows = [("DFEDTARU", f"{m}-01", "3.75") for m in month_span("2026-08", 3)]
        record = self.record("fed_funds", rows)
        self.assertEqual(record["value"], 3.75)
        self.assertEqual(record["history"][-1]["value"], 3.75)

    # the same contract on the other two transforms, where the rounding that
    # matters is the transform's own
    def test_every_transform_ends_its_history_on_the_tile_value(self):
        cases = [
            ("treasury_10y", self.rate_rows()),
            ("fed_funds", [("DFEDTARU", f"{m}-01", "3.75") for m in month_span("2026-08", 3)]),
            ("cpi", [("CPIAUCSL", f"{m}-01", f"{100.0 + i:.3f}")
                     for i, m in enumerate(month_span("2026-08", 26))]),
            ("rate_path", [
                ("DGS1", "2026-06-30", "3.80"), ("DGS1", "2026-07-31", "3.60"),
                ("EFFR", "2026-06-30", "4.33"), ("EFFR", "2026-07-31", "4.33"),
            ]),
        ]
        for indicator_id, rows in cases:
            record = self.record(indicator_id, rows)
            self.assertEqual(record["history"][-1]["value"], record["value"], indicator_id)
            self.assertEqual(record["history"][-1]["date"], record["date"], indicator_id)

    # forty basis points higher than the same month a year before
    def test_change_12m_sign_and_units_on_a_level(self):
        rows = [("DGS10", "2025-08-15", "4.08"), ("DGS10", "2026-08-15", "4.48")]
        record = self.record("treasury_10y", rows)
        self.assertEqual((record["value"], record["date"]), (4.48, "2026-08"))
        self.assertEqual(record["change_12m"], 0.4)

    # one cent a month for twelve months is 0.12, and the change rounds to one
    # decimal like every other tile
    def test_change_12m_rounds_to_one_decimal(self):
        self.assertEqual(self.record("treasury_10y", self.rate_rows())["change_12m"], 0.1)

    def test_change_12m_is_negative_when_the_level_falls(self):
        rows = [("UNRATE", "2025-08-01", "4.3"), ("UNRATE", "2026-08-01", "3.9")]
        self.assertEqual(self.record("unemployment", rows)["change_12m"], -0.4)

    # for a yoy tile the change is in points of rate, not points of index
    def test_change_12m_on_a_yoy_is_a_change_in_the_rate(self):
        rows = [
            ("CPIAUCSL", "2024-08-01", "100.000"),
            ("CPIAUCSL", "2025-08-01", "103.300"),
            ("CPIAUCSL", "2026-08-01", "106.300"),
        ]
        record = self.record("cpi", rows)
        self.assertEqual((record["value"], record["date"]), (2.9, "2026-08"))
        self.assertEqual(record["change_12m"], -0.4)

    def test_change_12m_is_null_without_a_base_month(self):
        rows = [("UNRATE", "2026-07-01", "4.2"), ("UNRATE", "2026-08-01", "4.3")]
        self.assertIsNone(self.record("unemployment", rows)["change_12m"])

    def test_history_is_capped_at_sixty_oldest_first(self):
        record = self.record("treasury_10y", self.rate_rows(count=70))
        self.assertEqual(indicators.HISTORY_MONTHS, 60)
        self.assertEqual(len(record["history"]), 60)
        dates = [point["date"] for point in record["history"]]
        self.assertEqual(dates, sorted(dates))
        self.assertEqual(dates[0], "2021-09")
        self.assertEqual(dates[-1], "2026-08")

    def test_history_is_shorter_when_the_series_is_shorter(self):
        record = self.record("treasury_10y", self.rate_rows(count=5))
        self.assertEqual([point["date"] for point in record["history"]],
                         ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"])

    def test_record_keys_come_from_the_contract(self):
        record = self.record("treasury_10y", self.rate_rows(count=3))
        self.assertEqual(list(record), ["id", "label", "group", "format", "provider",
                                        "note", "value", "date", "change_12m", "history"])
        spec = indicators.by_id("treasury_10y")
        self.assertEqual([record["label"], record["group"], record["format"], record["provider"]],
                         [spec["label"], spec["group"], spec["format"], spec["provider"]])
        self.assertIn(record["group"], indicators.GROUPS)


class TestIndicatorList(NationalCase):
    def test_a_missing_series_is_skipped_not_nulled(self):
        rows = [("CPIAUCSL", "2025-08-01", "100.000"), ("CPIAUCSL", "2026-08-01", "103.000")]
        records = bm.indicator_list(self.frame(rows))
        self.assertEqual([r["id"] for r in records], ["cpi"])
        self.assertEqual(records[0]["value"], 3.0)

    def test_order_follows_the_contract(self):
        rows = []
        for series in indicators.series_ids():
            rows += [(series, "2025-08-01", "100.000"), (series, "2026-08-01", "103.000")]
        records = bm.indicator_list(self.frame(rows))
        self.assertEqual([r["id"] for r in records], [spec["id"] for spec in indicators.INDICATORS])

    def test_empty_file_gives_an_empty_list(self):
        self.assertEqual(bm.indicator_list(self.frame([])), [])

    def test_updated_is_the_newest_observation_date(self):
        rows = [
            ("UNRATE", "2026-08-01", "4.3"),
            ("DGS10", "2026-09-12", "4.28"),
            ("DGS10", "2026-09-15", "."),
        ]
        self.assertEqual(bm.indicators_updated(self.frame(rows)), "2026-09-12")
        self.assertIsNone(bm.indicators_updated(self.frame([])))


class TestNationalBlock(NationalCase):
    ROWS = [("UNRATE", "2025-08-01", "4.3"), ("UNRATE", "2026-08-01", "3.9")]

    def test_mortgage_rate_is_untouched_by_the_indicators(self):
        alone = bm.national_block(FRED)
        both = bm.national_block(FRED, self.frame(self.ROWS))
        self.assertEqual(both["mortgage_rate"], alone["mortgage_rate"])
        self.assertEqual(both["mortgage_rate"], {
            "2014": 4.5, "2019": 4.0, "2024": 6.6, "latest": 6.76, "latest_date": "2026-09-10",
        })
        self.assertEqual(list(both), ["mortgage_rate", "indicators_updated", "indicators"])

    def test_indicators_without_a_mortgage_file(self):
        block = bm.national_block(None, self.frame(self.ROWS))
        self.assertNotIn("mortgage_rate", block)
        self.assertEqual([r["id"] for r in block["indicators"]], ["unemployment"])
        self.assertEqual(block["indicators_updated"], "2026-08-01")

    def test_neither_input_leaves_no_block(self):
        self.assertIsNone(bm.national_block(None, None))


class TestCollector(unittest.TestCase):
    # the daily series are cut to one row a month before they are written
    def test_month_end_keeps_the_last_observation_of_each_month(self):
        df = national.month_end(fred.parse_observations([
            {"date": "2026-07-30", "value": "4.01"},
            {"date": "2026-07-31", "value": "4.02"},
            {"date": "2026-08-03", "value": "4.11"},
            {"date": "2026-08-31", "value": "4.28"},
        ]))
        self.assertEqual(df["date"].tolist(), ["2026-07-31", "2026-08-31"])
        self.assertEqual(df["value"].tolist(), [4.02, 4.28])

    # a market holiday on the last business day must not blank the month
    def test_month_end_skips_a_trailing_dot(self):
        df = national.month_end(fred.parse_observations([
            {"date": "2026-08-28", "value": "4.25"},
            {"date": "2026-08-31", "value": "."},
        ]))
        self.assertEqual(df["date"].tolist(), ["2026-08-28"])
        self.assertEqual(df["value"].tolist(), [4.25])

    def test_month_end_of_nothing_is_empty(self):
        df = national.month_end(fred.parse_observations([]))
        self.assertEqual(len(df), 0)

    def test_every_daily_series_is_one_the_contract_asks_for(self):
        self.assertTrue(set(national.DAILY) <= set(indicators.series_ids()))

    def test_out_file_is_the_path_the_build_reads(self):
        self.assertEqual(national.OUT_FILE, bm.DEFAULT_PATHS["national"])


if __name__ == "__main__":
    unittest.main()

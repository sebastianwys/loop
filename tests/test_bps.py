import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import requests

from bot.build_map_data import RESERVED
from bot.collectors import bps, pep

# the two header lines and the blank third line of every annual file
HEADER = (
    "Survey,CSA,CBSA,MONCOV,CBSA,,1-unit,,,2-units,,,3-4 units,,,5+ units,,,"
    "1-unit rep,,,2-units rep,,,3-4 units rep,,,5+ units rep\n"
    "Date,Code,Code,,Name,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,Bldgs,Units,Value,"
    "Bldgs,Units,Value,Bldgs,Units,Value,      Bldgs,Units,Value,Bldgs,Units,Value\n"
    " \n"
)

# copied from ma2014a.txt and checked by hand: abilene permitted 284 single
# family units and nothing else, chicago 7723 + 124 + 439 + 7393 = 15679
ABILENE_2014 = ("201499,999,10180, ,Abilene  TX ,284,284,58424,0,0,0,0,0,0,0,0,0,"
                "283,283,58074,0,0,0,0,0,0,0,0,0\n")
CHICAGO_2014 = ("201499,176,16980,C,Chicago-Naperville-Elgin  IL-IN-WI ,7723,7723,2180831,62,124,19992,"
                "131,439,70622,201,7393,1113734,7328,7328,2108475,55,110,18334,131,439,70622,178,7264,1107118\n")
FILE_2014 = HEADER + ABILENE_2014 + CHICAGO_2014

# from 2024 the fourth field is a header code and micropolitan areas are included
HEADER_2024 = HEADER.replace("MONCOV", "HHEADER")
ABILENE_2024 = ("202499,101,10180,2,Abilene  TX ,431,431,120144,48,96,14788,0,0,0,0,0,0,"
                "431,431,120144,48,96,14788,0,0,0,0,0,0\n")
YANKTON_2024 = ("202499,999,49460,5,Yankton  SD ,41,41,11910,0,0,0,2,8,1500,10,130,12500,"
                "41,41,11910,0,0,0,2,8,1500,10,130,12500\n")
FILE_2024 = HEADER_2024 + ABILENE_2024 + YANKTON_2024

# copied from ma2014a.txt. the villages was 45540 until july 2023 made it
# 48680 on the same county, and cleveland was 17460 until 17410 took in
# ashtabula as well
VILLAGES_2014 = ("201499,422,45540,C,The Villages  FL ,2570,2570,733957,0,0,0,0,0,0,0,0,0,"
                 "2570,2570,733957,0,0,0,0,0,0,0,0,0\n")
CLEVELAND_2014 = ("201499,184,17460,C,Cleveland-Elyria  OH ,2256,2256,599567,22,44,1301,21,81,8860,31,519,37807,"
                  "2144,2144,589533,9,18,1170,21,81,8860,31,519,37807\n")


def lookup(metrics):
    return {(code, metric, period): value for code, metric, period, value
            in zip(metrics.cbsa_code, metrics.metric, metrics.period, metrics.value)}


class TestParseBaseCases(unittest.TestCase):
    def test_columns_and_row_count(self):
        df = bps.parse_annual(FILE_2014)
        self.assertEqual(list(df.columns), bps.PARSED)
        self.assertEqual(len(df), 2)

    def test_abilene_by_hand(self):
        row = bps.parse_annual(FILE_2014).set_index("cbsa_code").loc["10180"]
        self.assertEqual(row["year"], 2014)
        self.assertEqual(row["name"], "Abilene, TX")
        self.assertEqual((row.units_1, row.units_2, row.units_3_4, row.units_5plus), (284, 0, 0, 0))

    def test_chicago_reads_all_four_classes(self):
        row = bps.parse_annual(FILE_2014).set_index("cbsa_code").loc["16980"]
        self.assertEqual(row["name"], "Chicago-Naperville-Elgin, IL-IN-WI")
        self.assertEqual((row.units_1, row.units_2, row.units_3_4, row.units_5plus), (7723, 124, 439, 7393))

    # the block without imputation repeats the layout with smaller numbers. abilene
    # reported 283 single family buildings against 284 with imputation
    def test_units_come_from_the_imputed_block_not_reported_only(self):
        row = bps.parse_annual(FILE_2014).set_index("cbsa_code").loc["10180"]
        self.assertEqual(row.units_1, 284)

    def test_2024_layout_keeps_header_code_rows_and_micro_areas(self):
        df = bps.parse_annual(FILE_2024).set_index("cbsa_code")
        self.assertEqual(df.index.tolist(), ["10180", "49460"])
        self.assertEqual((df.loc["10180"].units_1, df.loc["10180"].units_2), (431, 96))
        self.assertEqual((df.loc["49460"].units_3_4, df.loc["49460"].units_5plus), (8, 130))

    def test_unit_columns_are_numeric(self):
        df = bps.parse_annual(FILE_2014)
        for col in bps.UNIT_FIELDS:
            self.assertIn(df[col].dtype.kind, "iuf")

    def test_cbsa_code_is_a_string(self):
        df = bps.parse_annual(FILE_2014)
        self.assertTrue(all(isinstance(c, str) for c in df.cbsa_code))


class TestMetricsBaseCases(unittest.TestCase):
    def test_exact_numbers(self):
        got = lookup(bps.annual_metrics(bps.parse_annual(FILE_2014)))
        self.assertEqual(got[("10180", "permits_units", "2014")], 284)
        self.assertEqual(got[("10180", "permits_single_family", "2014")], 284)
        self.assertEqual(got[("10180", "permits_multifamily", "2014")], 0)
        self.assertEqual(got[("16980", "permits_units", "2014")], 15679)
        self.assertEqual(got[("16980", "permits_single_family", "2014")], 7723)
        self.assertEqual(got[("16980", "permits_multifamily", "2014")], 7393)

    def test_2024_numbers(self):
        got = lookup(bps.annual_metrics(bps.parse_annual(FILE_2024)))
        self.assertEqual(got[("10180", "permits_units", "2024")], 527)
        self.assertEqual(got[("49460", "permits_units", "2024")], 179)
        self.assertEqual(got[("49460", "permits_multifamily", "2024")], 130)

    def test_contract_columns_and_period_format(self):
        metrics = bps.annual_metrics(bps.parse_annual(FILE_2014))
        self.assertEqual(list(metrics.columns), ["cbsa_code", "metric", "period", "value"])
        self.assertEqual(set(metrics.period), {"2014"})
        self.assertEqual(len(metrics), 6)

    def test_three_metrics_per_area(self):
        metrics = bps.annual_metrics(bps.parse_annual(FILE_2014))
        self.assertEqual(sorted(metrics.metric.unique()),
                         ["permits_multifamily", "permits_single_family", "permits_units"])

    def test_metric_names_are_not_reserved(self):
        self.assertFalse(set(bps.METRICS) & RESERVED)

    def test_values_are_integers(self):
        metrics = bps.annual_metrics(bps.parse_annual(FILE_2014))
        self.assertEqual(metrics.value.dtype.kind, "i")

    # written and read back through pandas, the way the builder loads it
    def test_round_trip_keeps_codes_and_periods_as_strings(self):
        metrics = bps.annual_metrics(bps.parse_annual(FILE_2014))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "metrics.csv"
            metrics.to_csv(path, index=False)
            back = pd.read_csv(path, dtype={"cbsa_code": str, "metric": str, "period": str})
        self.assertEqual(back.cbsa_code.tolist(), metrics.cbsa_code.tolist())
        self.assertEqual(back.period.tolist(), metrics.period.tolist())


class TestUrls(unittest.TestCase):
    def test_metro_folder_through_2023(self):
        self.assertEqual(bps.file_url(2014), bps.METRO_DIR + "ma2014a.txt")
        self.assertEqual(bps.file_url(2023), bps.METRO_DIR + "ma2023a.txt")

    def test_cbsa_folder_from_2024(self):
        self.assertEqual(bps.file_url(2024), bps.CBSA_DIR + "cbsa2024a.txt")
        self.assertEqual(bps.file_url(2025), bps.CBSA_DIR + "cbsa2025a.txt")

    def test_folders_are_under_the_bps_root(self):
        for year in (2014, 2024):
            self.assertTrue(bps.file_url(year).startswith("https://www2.census.gov/econ/bps/"))


class TestParseEdgeCases(unittest.TestCase):
    # the 2014 to 2016 files end lines with crlf
    def test_crlf_line_endings(self):
        crlf = bps.annual_metrics(bps.parse_annual(FILE_2014.replace("\n", "\r\n")))
        lf = bps.annual_metrics(bps.parse_annual(FILE_2014))
        self.assertEqual(lookup(crlf), lookup(lf))

    def test_trailing_commas_and_trailing_blank_lines(self):
        text = HEADER + ABILENE_2014.rstrip("\n") + ",,,\n" + CHICAGO_2014.rstrip("\n") + ",\n\n\n   \n"
        self.assertEqual(lookup(bps.annual_metrics(bps.parse_annual(text))),
                         lookup(bps.annual_metrics(bps.parse_annual(FILE_2014))))

    def test_empty_text_gives_the_documented_columns(self):
        df = bps.parse_annual("")
        self.assertEqual(list(df.columns), bps.PARSED)
        self.assertEqual(len(df), 0)
        metrics = bps.annual_metrics(df)
        self.assertEqual(list(metrics.columns), bps.COLUMNS)
        self.assertEqual(len(metrics), 0)

    def test_header_only_file_is_empty(self):
        self.assertEqual(len(bps.parse_annual(HEADER)), 0)

    def test_leading_zero_code_is_kept(self):
        text = HEADER + ABILENE_2014.replace("10180", "01234")
        df = bps.parse_annual(text)
        self.assertEqual(df.cbsa_code.tolist(), ["01234"])
        metrics = bps.annual_metrics(df)
        self.assertEqual(set(metrics.cbsa_code), {"01234"})

    def test_year_comes_from_the_survey_date(self):
        yyyy99 = bps.parse_annual(HEADER + ABILENE_2014)
        yyyy = bps.parse_annual(HEADER + ABILENE_2014.replace("201499", "2014"))
        self.assertEqual(yyyy99.year.tolist(), [2014])
        self.assertEqual(yyyy.year.tolist(), [2014])

    # a blank unit count is missing, not zero
    def test_blank_unit_count_is_missing(self):
        text = HEADER + "201499,999,10180, ,Abilene  TX ,284,284,58424,0,0,0,0,0,0,0,,0,0,0,0,0,0,0,0,0,0,0,0,0\n"
        df = bps.parse_annual(text)
        self.assertEqual(len(df), 1)
        self.assertTrue(pd.isna(df.units_5plus.iloc[0]))
        self.assertEqual(df.units_1.iloc[0], 284)

    def test_non_numeric_unit_count_is_missing(self):
        text = HEADER + ABILENE_2014.replace(",284,284,58424,", ",284,n/a,58424,")
        df = bps.parse_annual(text)
        self.assertTrue(pd.isna(df.units_1.iloc[0]))

    def test_malformed_rows_are_skipped(self):
        text = HEADER + "".join([
            "201499,999,10180\n",
            "201499,999,1018, ,Short code  TX ,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1\n",
            "abcd99,999,10181, ,Bad date  TX ,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1\n",
            "201499,999,99999, ,Not an area ,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1\n",
            ",,,,,,,,,,,,,,,,,,,,,,,,,,,,\n",
            "garbage\n",
            CHICAGO_2014,
        ])
        df = bps.parse_annual(text)
        self.assertEqual(df.cbsa_code.tolist(), ["16980"])


class TestMetricsEdgeCases(unittest.TestCase):
    # only the metrics that use the missing class are left out
    def test_missing_input_skips_only_those_metrics(self):
        text = HEADER + "201499,999,10180, ,Abilene  TX ,284,284,58424,0,0,0,0,0,0,0,,0,0,0,0,0,0,0,0,0,0,0,0,0\n"
        got = lookup(bps.annual_metrics(bps.parse_annual(text)))
        self.assertEqual(got, {("10180", "permits_single_family", "2014"): 284})

    def test_missing_single_family_keeps_multifamily(self):
        text = HEADER + CHICAGO_2014.replace(",7723,7723,2180831,", ",7723,,2180831,")
        got = lookup(bps.annual_metrics(bps.parse_annual(text)))
        self.assertEqual(got, {("16980", "permits_multifamily", "2014"): 7393})

    def test_year_with_no_data_yields_no_rows_for_that_year(self):
        frames = [bps.parse_annual(FILE_2014), bps.parse_annual(HEADER),
                  bps.parse_annual(FILE_2014.replace("201499", "201699"))]
        metrics = bps.annual_metrics(pd.concat(frames, ignore_index=True))
        self.assertEqual(sorted(metrics.period.unique()), ["2014", "2016"])
        self.assertEqual(len(metrics), 12)

    def test_duplicate_area_within_a_year_keeps_the_first(self):
        text = HEADER + ABILENE_2014 + ABILENE_2014.replace(",284,284,58424,", ",999,999,58424,")
        got = lookup(bps.annual_metrics(bps.parse_annual(text)))
        self.assertEqual(got[("10180", "permits_single_family", "2014")], 284)
        self.assertEqual(len(got), 3)

    def test_same_area_in_two_years_is_not_a_duplicate(self):
        frames = [bps.parse_annual(FILE_2014), bps.parse_annual(FILE_2024)]
        metrics = bps.annual_metrics(pd.concat(frames, ignore_index=True))
        abilene = metrics[(metrics.cbsa_code == "10180") & (metrics.metric == "permits_units")]
        self.assertEqual(dict(zip(abilene.period, abilene.value)), {"2014": 284, "2024": 527})

    def test_all_zero_row_is_kept(self):
        text = HEADER + "201499,999,10180, ,Abilene  TX ,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0\n"
        got = lookup(bps.annual_metrics(bps.parse_annual(text)))
        self.assertEqual(got[("10180", "permits_units", "2014")], 0)

    def test_stray_years(self):
        df = bps.parse_annual(FILE_2014 + ABILENE_2014.replace("201499", "201599"))
        self.assertEqual(bps.stray_years(df, 2014), [2015])
        self.assertEqual(bps.stray_years(bps.parse_annual(FILE_2014), 2014), [])
        self.assertEqual(bps.stray_years(bps.parse_annual(""), 2014), [])


class TestRenumbered(unittest.TestCase):
    def test_a_retired_code_lands_under_the_current_one(self):
        got = lookup(bps.annual_metrics(bps.parse_annual(HEADER + VILLAGES_2014)))
        self.assertEqual(got, {("48680", "permits_units", "2014"): 2570,
                               ("48680", "permits_single_family", "2014"): 2570,
                               ("48680", "permits_multifamily", "2014"): 0})

    # ashtabula moved into 17410, so 17460 is not the same counties
    def test_a_code_that_moved_a_county_stays_where_it_was_printed(self):
        got = lookup(bps.annual_metrics(bps.parse_annual(HEADER + CLEVELAND_2014)))
        self.assertEqual(got[("17460", "permits_units", "2014")], 2256 + 44 + 81 + 519)
        self.assertNotIn("17410", {code for code, _, _ in got})

    # a year printing both codes keeps the row printed under the current one,
    # whichever comes first
    def test_the_current_code_wins_when_both_are_printed(self):
        current = VILLAGES_2014.replace(",45540,", ",48680,").replace(",2570,2570,733957,", ",100,100,733957,", 1)
        for rows in (VILLAGES_2014 + current, current + VILLAGES_2014):
            got = lookup(bps.annual_metrics(bps.parse_annual(HEADER + rows)))
            self.assertEqual(got[("48680", "permits_units", "2014")], 100)
            self.assertEqual(len(got), 3)

    def test_the_same_pairs_as_pep(self):
        self.assertIs(bps.RENUMBERED, pep.RENUMBERED)


class FakeResponse:
    def __init__(self, status_code, content=b""):
        self.status_code = status_code
        self.content = content

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")


# serves 2014 through 2025 from the fixtures and 404 for anything later
def fake_fetch(url, **kwargs):
    year = int(url[-9:-5])
    if year > 2025:
        return FakeResponse(404)
    if year >= bps.SPLIT_YEAR:
        return FakeResponse(200, FILE_2024.replace("202499", f"{year}99").encode("latin-1"))
    return FakeResponse(200, FILE_2014.replace("201499", f"{year}99").encode("latin-1"))


class TestCollectOffline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "bps"

    def tearDown(self):
        self.tmp.cleanup()

    def test_walks_every_year_and_stops_at_the_first_404(self):
        with patch("bot.collectors.bps.fetch", side_effect=fake_fetch) as fetched:
            out = bps.collect(self.out)
        self.assertEqual(fetched.call_count, 13)
        self.assertEqual(out, self.out / "metrics.csv")
        names = sorted(p.name for p in self.out.iterdir())
        self.assertIn("ma2014a.txt", names)
        self.assertIn("ma2023a.txt", names)
        self.assertIn("cbsa2025a.txt", names)
        self.assertNotIn("cbsa2026a.txt", names)

    def test_raw_files_are_saved_byte_for_byte(self):
        with patch("bot.collectors.bps.fetch", side_effect=fake_fetch):
            bps.collect(self.out)
        self.assertEqual((self.out / "ma2014a.txt").read_bytes(), FILE_2014.encode("latin-1"))

    def test_metrics_cover_every_year_and_the_manifest_leads_with_the_version(self):
        with patch("bot.collectors.bps.fetch", side_effect=fake_fetch):
            bps.collect(self.out)
        metrics = pd.read_csv(self.out / "metrics.csv", dtype={"cbsa_code": str, "period": str})
        self.assertEqual(list(metrics.columns), bps.COLUMNS)
        self.assertEqual(sorted(metrics.period.unique()), [str(y) for y in range(2014, 2026)])
        entries = json.loads((self.out / "download_manifest.json").read_text())
        self.assertEqual(entries[0]["filename"], "metrics.csv")
        self.assertEqual(entries[0]["version"], "2014 to 2025 annual")
        self.assertEqual(entries[0]["integrity"]["row_count"], len(metrics))
        self.assertEqual(len(entries), 13)
        self.assertEqual(entries[1]["filename"], "ma2014a.txt")
        self.assertEqual(entries[1]["version"], "2014 annual")
        self.assertEqual(entries[-1]["source"]["endpoint"], bps.file_url(2025))

    def test_the_manifest_names_the_codes_filed_under_their_successor(self):
        with patch("bot.collectors.bps.fetch", side_effect=fake_fetch):
            bps.collect(self.out)
        entries = json.loads((self.out / "download_manifest.json").read_text())
        self.assertEqual(entries[0]["notes"]["renumbered"], bps.RENUMBERED)

    def test_missing_required_year_raises(self):
        def gone(url, **kwargs):
            return FakeResponse(404)
        with patch("bot.collectors.bps.fetch", side_effect=gone):
            with self.assertRaises(requests.HTTPError):
                bps.collect(self.out)

    def test_server_error_on_a_probe_year_is_not_the_end_of_the_series(self):
        def flaky(url, **kwargs):
            return FakeResponse(503) if url.endswith("cbsa2025a.txt") else fake_fetch(url)
        with patch("bot.collectors.bps.fetch", side_effect=flaky):
            with self.assertRaises(requests.HTTPError):
                bps.collect(self.out)

    def test_file_with_the_wrong_survey_year_raises(self):
        def mislabeled(url, **kwargs):
            if url.endswith("ma2015a.txt"):
                return FakeResponse(200, FILE_2014.encode("latin-1"))
            return fake_fetch(url)
        with patch("bot.collectors.bps.fetch", side_effect=mislabeled):
            with self.assertRaises(RuntimeError):
                bps.collect(self.out)


if __name__ == "__main__":
    unittest.main()

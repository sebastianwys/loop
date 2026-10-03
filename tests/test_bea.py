import io
import json
import os
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest import mock

import pandas as pd
import requests

from bot import build_map_data as bm
from bot.collectors import bea, irs

# every payload in this file is synthetic. it copies the documented shape of
# a BEAAPI response (Results.Data rows carrying GeoFips, GeoName, TimePeriod,
# DataValue with thousands separators, CL_UNIT and UNIT_MULT) with invented
# numbers. nothing here was fetched from the api, and no test opens the network
FAKE_KEY = "0000AAAA-1111-2222-3333-444455556666"
THIS_YEAR = 2026
BULK = bea.year_param(bea.bulk_years(THIS_YEAR))
NAMES = {"48441": "Taylor, TX", "48059": "Callahan, TX", "17031": "Cook, IL", "17043": "DuPage, IL",
         "17097": "Lake, IL", "01001": "Autauga, AL", "48301": "Loving, TX"}

# (county, year) -> (personal income in thousands, population). taylor and
# callahan make up abilene 10180. cook and dupage sit in the chicago division
# 16984 and, with lake, in the chicago msa 16980. autauga is alone in 33860
# and loving is in no cbsa
VALUES = {
    ("48441", "2014"): ("6,000,000", "140,000"),
    ("48059", "2014"): ("500,000", "13,500"),
    ("17031", "2014"): ("300,000,000", "5,200,000"),
    ("17043", "2014"): ("60,000,000", "930,000"),
    ("17097", "2014"): ("40,000,000", "700,000"),
    ("01001", "2014"): ("2,214,858", "55,000"),
    ("48301", "2014"): ("5,000", "64"),
    ("48441", "2024"): ("9,000,000", "150,000"),
    ("48059", "2024"): ("800,000", "14,500"),
    ("17031", "2024"): ("420,000,000", "5,100,000"),
    ("17043", "2024"): ("80,000,000", "920,000"),
    ("17097", "2024"): ("55,000,000", "710,000"),
    ("01001", "2024"): ("3,000,000", "60,000"),
    ("48301", "2024"): ("6,000", "60"),
}

# computed by hand from the fixture
ABILENE_INCOME_2014 = 6_000_000 + 500_000
ABILENE_POPULATION_2014 = 140_000 + 13_500
ABILENE_PER_CAPITA_2014 = 42_345
ABILENE_INCOME_2024 = 9_000_000 + 800_000
ABILENE_POPULATION_2024 = 150_000 + 14_500
ABILENE_PER_CAPITA_2024 = 59_574
DIVISION_INCOME_2014 = 300_000_000 + 60_000_000
DIVISION_POPULATION_2014 = 5_200_000 + 930_000
DIVISION_PER_CAPITA_2014 = 58_728
MSA_INCOME_2014 = DIVISION_INCOME_2014 + 40_000_000
MSA_POPULATION_2014 = DIVISION_POPULATION_2014 + 700_000
MSA_PER_CAPITA_2014 = 58_565
DIVISION_INCOME_2024 = 420_000_000 + 80_000_000


def row(fips, period, value, line="1"):
    spec = bea.LINES[line]
    return {"Code": f"CAINC1-{line}", "GeoFips": fips, "GeoName": NAMES.get(fips, fips), "TimePeriod": period,
            "CL_UNIT": spec["unit"], "UNIT_MULT": spec["unit_mult"], "DataValue": value}


def income_rows(values=VALUES):
    return [row(fips, period, income) for (fips, period), (income, _) in values.items()]


def population_rows(values=VALUES):
    return [row(fips, period, population, "2") for (fips, period), (_, population) in values.items()]


def crosswalk():
    return pd.DataFrame({
        "county_fips": ["48441", "48059", "17031", "17043", "17097", "17031", "17043", "01001"],
        "cbsa_code": ["10180", "10180", "16980", "16980", "16980", "16984", "16984", "33860"],
    })


def payload(rows, line="1", years=BULK, key=FAKE_KEY):
    return {"BEAAPI": {
        "Request": {"RequestParam": [
            {"ParameterName": "USERID", "ParameterValue": key},
            {"ParameterName": "DATASETNAME", "ParameterValue": "REGIONAL"},
            {"ParameterName": "RESULTFORMAT", "ParameterValue": "JSON"},
            {"ParameterName": "METHOD", "ParameterValue": "GETDATA"},
            {"ParameterName": "TABLENAME", "ParameterValue": "CAINC1"},
            {"ParameterName": "LINECODE", "ParameterValue": line},
            {"ParameterName": "GEOFIPS", "ParameterValue": "COUNTY"},
            {"ParameterName": "YEAR", "ParameterValue": years},
        ]},
        "Results": {
            "Statistic": "Personal income" if line == "1" else "Population",
            "UnitOfMeasure": bea.LINES[line]["unit"],
            "PublicTable": "CAINC1 Personal Income Summary: Personal Income, Population, Per Capita Personal Income",
            "UTCProductionTime": "2026-01-01T00:00:00.000",
            "NoteRef": "1",
            "Dimensions": [
                {"Name": "GeoFips", "DataType": "string", "IsValue": "0"},
                {"Name": "TimePeriod", "DataType": "string", "IsValue": "0"},
                {"Name": "DataValue", "DataType": "numeric", "IsValue": "1"},
            ],
            "Data": rows,
            "Notes": [{"NoteRef": "1", "NoteText": "synthetic fixture"}],
        },
    }}


def error_payload(code="101", description="Unknown error."):
    return {"BEAAPI": {
        "Request": {"RequestParam": [{"ParameterName": "USERID", "ParameterValue": FAKE_KEY}]},
        "Error": {"APIErrorCode": code, "APIErrorDescription": description},
    }}


class FakeResponse:
    def __init__(self, body=None, status=200, json_ok=True, content=b""):
        self.status_code = status
        self.ok = status < 400
        self.content = content
        self._body = body
        self._json_ok = json_ok

    def json(self):
        if not self._json_ok:
            raise ValueError("not json")
        return self._body


# routes a bea request to a canned response by line code and year list, the
# delineation download by its url. a line and year with no canned response
# answers bea's error 101, which is what an unpublished year gets
def fake_fetch(responses, calls):
    def fetch(url, params=None, **kwargs):
        if url == irs.DELINEATION_URL:
            item = responses["delineation"]
        else:
            calls.append(dict(params))
            item = responses.get(f"{params['LineCode']}:{params['Year']}", FakeResponse(error_payload()))
        if isinstance(item, Exception):
            raise item
        return item
    return fetch


def good_responses():
    return {f"1:{BULK}": FakeResponse(payload(income_rows(), "1")),
            f"2:{BULK}": FakeResponse(payload(population_rows(), "2"))}


HEADER = ["CBSA Code", "Metropolitan Division Code", "CSA Code", "CBSA Title",
          "Metropolitan/Micropolitan Statistical Area", "Metropolitan Division Title", "CSA Title",
          "County/County Equivalent", "State Name", "FIPS State Code", "FIPS County Code",
          "Central/Outlying County"]


# a workbook shaped like list1_2023.xlsx: two title rows, the header, county
# rows, then the note rows the census bureau appends
def workbook(rows):
    frame = pd.DataFrame(rows, columns=HEADER)
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        frame.to_excel(writer, index=False, startrow=2, sheet_name="List 1")
        writer.sheets["List 1"]["A1"] = "List 1. Core based statistical areas, July 2023"
    return buffer.getvalue()


def county_row(cbsa, division, county, state_fips, county_fips):
    return [cbsa, division, None, "Title", "Metropolitan Statistical Area", None, None,
            county, "State", state_fips, county_fips, "Central"]


def value_of(out, code, metric, period):
    rows = out[(out.cbsa_code == code) & (out.metric == metric) & (out.period == period)]
    if len(rows) != 1:
        raise AssertionError(f"{len(rows)} rows for {code} {metric} {period}")
    return int(rows.value.iloc[0])


def roll(values=VALUES, period="2014", walk=None):
    paired = bea.pair_lines(bea.parse_counties(income_rows(values)), bea.parse_counties(population_rows(values)), period)
    return bea.rollup(paired, crosswalk() if walk is None else walk, period)


class TestBeaParse(unittest.TestCase):
    def test_parse_value(self):
        self.assertEqual(bea.parse_value("7,116,829"), 7116829.0)
        self.assertEqual(bea.parse_value("45,123"), 45123.0)
        self.assertEqual(bea.parse_value(" 1.5 "), 1.5)
        self.assertEqual(bea.parse_value(12), 12.0)
        self.assertEqual(bea.parse_value("0"), 0.0)
        for text in ("(NA)", "(D)", "(L)", "", "   ", None, "n/a", "nan", "inf"):
            self.assertIsNone(bea.parse_value(text), repr(text))

    def test_period_year(self):
        self.assertEqual(bea.period_year("2024"), 2024)
        self.assertEqual(bea.period_year(" 2019 "), 2019)
        for text in ("2024Q1", "24", "", None, "2024-01"):
            self.assertIsNone(bea.period_year(text), repr(text))

    def test_county_fips_keeps_five_digits_and_leading_zeros(self):
        self.assertEqual(bea.county_fips("48441"), "48441")
        self.assertEqual(bea.county_fips("01001"), "01001")
        self.assertEqual(bea.county_fips(" 51901 "), "51901")
        for fips in (None, "", "abc", "1001", "48441M", "480000", "COUNTY", 1001):
            self.assertIsNone(bea.county_fips(fips), repr(fips))

    def test_documented_columns_and_exact_values(self):
        df = bea.parse_counties(income_rows())
        self.assertEqual(list(df.columns), ["county_fips", "period", "value"])
        self.assertEqual(len(df), len(VALUES))
        taylor = df[(df.county_fips == "48441") & (df.period == "2014")].iloc[0]
        self.assertEqual(taylor.value, 6000000.0)
        self.assertEqual(df.value.dtype.kind, "f")
        self.assertTrue(all(isinstance(p, str) and len(p) == 4 for p in df.period))

    def test_thousands_separators_are_removed(self):
        df = bea.parse_counties([row("48441", "2024", "9,180,520"), row("48059", "2024", "822,731", "2")])
        self.assertEqual(df.value.tolist(), [822731.0, 9180520.0])

    # bea flags suppressed or unavailable cells in parentheses
    def test_flagged_rows_are_skipped(self):
        df = bea.parse_counties([
            row("48441", "2014", "(NA)"), row("48441", "2015", "(D)"), row("48441", "2016", ""),
            row("48441", "2017", None), row("48441", "2018", "5"),
        ])
        self.assertEqual(list(zip(df.period, df.value)), [("2018", 5.0)])

    # bea writes 0 for a geography it did not estimate that year, so a zero
    # county must drop out rather than sum as nothing
    def test_zero_and_negative_values_are_unavailable(self):
        df = bea.parse_counties([row("09110", "2014", "0", "2"), row("09110", "2015", 0, "2"),
                                 row("09110", "2016", "-1", "2"), row("09110", "2024", "991,508", "2")])
        self.assertEqual(list(zip(df.period, df.value)), [("2024", 991508.0)])

    def test_duplicates_keep_the_first_value(self):
        df = bea.parse_counties([row("48441", "2024", "1"), row("48441", "2024", "2"), row("48441", "2024", "(NA)")])
        self.assertEqual(list(zip(df.period, df.value)), [("2024", 1.0)])

    def test_years_before_first_year_are_dropped(self):
        df = bea.parse_counties([row("48441", "2013", "1"), row("48441", "2014", "2")])
        self.assertEqual(df.period.tolist(), ["2014"])
        self.assertEqual(bea.parse_counties([row("48441", "2014", "2")], first_year=2020).period.tolist(), [])

    def test_empty_data_yields_the_documented_columns(self):
        df = bea.parse_counties([])
        self.assertEqual(list(df.columns), ["county_fips", "period", "value"])
        self.assertEqual(len(df), 0)
        self.assertEqual(bea.data_rows({"Data": []}), [])
        self.assertEqual(bea.data_rows({}), [])
        self.assertEqual(bea.data_rows({"Data": "oops"}), [])

    def test_single_row_object_is_treated_as_a_list(self):
        rows = bea.data_rows({"Data": row("48441", "2024", "1")})
        self.assertEqual(len(rows), 1)
        self.assertEqual(bea.parse_counties(rows).county_fips.tolist(), ["48441"])

    def test_malformed_rows_are_skipped(self):
        rows = [
            {"GeoName": "Taylor, TX", "TimePeriod": "2024", "DataValue": "1"},
            {"GeoFips": "48441", "DataValue": "1"},
            row("48441", "2024Q1", "1"),
            row("48441", "24", "1"),
            row("48441", "2024", "n/a"),
            row("abc", "2024", "1"),
            row("COUNTY", "2024", "1"),
            "not a row",
            None,
            row("48441", "2024", "9"),
        ]
        df = bea.parse_counties(rows)
        self.assertEqual(list(zip(df.county_fips, df.period, df.value)), [("48441", "2024", 9.0)])


class TestBeaResults(unittest.TestCase):
    def test_results_block_is_returned(self):
        block = bea.results(payload(income_rows()))
        self.assertEqual(len(block["Data"]), len(VALUES))

    def test_top_level_error_is_an_api_error_with_its_code(self):
        with self.assertRaises(bea.ApiError) as ctx:
            bea.results(error_payload("3", "The BEA API UserID provided is not valid"))
        self.assertEqual(ctx.exception.code, "3")
        self.assertIn("not valid", str(ctx.exception))
        self.assertIsInstance(ctx.exception, RuntimeError)

    def test_error_inside_results_raises(self):
        body = {"BEAAPI": {"Results": {"Error": {"APIErrorCode": "40", "APIErrorDescription": "bad table"}}}}
        with self.assertRaises(bea.ApiError) as ctx:
            bea.results(body)
        self.assertEqual(ctx.exception.code, "40")

    def test_results_list_is_unwrapped(self):
        body = {"BEAAPI": {"Results": [{"Data": [row("48441", "2024", "1")]}]}}
        self.assertEqual(len(bea.results(body)["Data"]), 1)

    def test_missing_beaapi_raises(self):
        for body in ({}, {"other": 1}, "text", None, {"BEAAPI": "oops"}):
            with self.assertRaises(RuntimeError):
                bea.results(body)


class TestBeaUnits(unittest.TestCase):
    def test_expected_units_pass(self):
        bea.check_units(income_rows(), "1")
        bea.check_units(population_rows(), "2")
        bea.check_units([dict(row("48441", "2024", "7"), CL_UNIT="THOUSANDS OF DOLLARS", UNIT_MULT=3)], "1")

    def test_changed_multiplier_raises(self):
        rows = income_rows() + [dict(row("48441", "2019", "7"), UNIT_MULT="6")]
        with self.assertRaises(RuntimeError) as ctx:
            bea.check_units(rows, "1")
        self.assertIn("UNIT_MULT", str(ctx.exception))
        self.assertIn("line 1", str(ctx.exception))

    def test_changed_unit_raises(self):
        rows = [dict(row("48441", "2024", "7", "2"), CL_UNIT="Thousands of persons")]
        with self.assertRaises(RuntimeError) as ctx:
            bea.check_units(rows, "2")
        self.assertIn("Number of persons", str(ctx.exception))

    def test_swapped_lines_raise(self):
        with self.assertRaises(RuntimeError):
            bea.check_units(population_rows(), "1")
        with self.assertRaises(RuntimeError):
            bea.check_units(income_rows(), "2")

    def test_missing_unit_fields_raise(self):
        with self.assertRaises(RuntimeError):
            bea.check_units([{"GeoFips": "48441", "TimePeriod": "2024", "DataValue": "7"}], "1")

    def test_no_rows_pass(self):
        bea.check_units([], "1")
        bea.check_units([], "2")


class TestBeaYears(unittest.TestCase):
    def test_bulk_years_run_from_first_year_to_last_calendar_year(self):
        self.assertEqual(bea.bulk_years(2026), list(range(2014, 2026)))
        self.assertEqual(bea.bulk_years(2015), [2014])
        self.assertEqual(bea.bulk_years(2026)[-1], 2025)

    def test_year_param_is_a_comma_list(self):
        self.assertEqual(bea.year_param([2014, 2015]), "2014,2015")
        self.assertEqual(bea.year_param(bea.bulk_years(2026)),
                         "2014,2015,2016,2017,2018,2019,2020,2021,2022,2023,2024,2025")
        self.assertEqual(bea.year_param([2026]), "2026")

    def test_line_params_ask_for_counties_and_never_all(self):
        params = bea.line_params("1", bea.bulk_years(2026))
        self.assertEqual((params["method"], params["TableName"], params["LineCode"], params["GeoFips"]),
                         ("GetData", "CAINC1", "1", "COUNTY"))
        self.assertNotIn("ALL", params["Year"])
        self.assertNotIn("LAST", params["Year"])
        self.assertEqual(bea.line_params("2", [2026])["Year"], "2026")


class TestBeaRollup(unittest.TestCase):
    def test_two_county_cbsa_sums_by_hand(self):
        out = roll()
        self.assertEqual(value_of(out, "10180", "bea_personal_income", "2014"), ABILENE_INCOME_2014)
        self.assertEqual(value_of(out, "10180", "bea_personal_income", "2014"), 6_500_000)
        self.assertEqual(value_of(out, "10180", "bea_population", "2014"), ABILENE_POPULATION_2014)
        self.assertEqual(value_of(out, "10180", "bea_population", "2014"), 153_500)
        out = roll(period="2024")
        self.assertEqual(value_of(out, "10180", "bea_personal_income", "2024"), ABILENE_INCOME_2024)
        self.assertEqual(value_of(out, "10180", "bea_population", "2024"), ABILENE_POPULATION_2024)

    # income is in thousands of dollars, so the ratio is scaled by 1000
    def test_per_capita_by_hand(self):
        out = roll()
        self.assertEqual(value_of(out, "10180", "bea_income_per_capita", "2014"), ABILENE_PER_CAPITA_2014)
        self.assertEqual(value_of(out, "10180", "bea_income_per_capita", "2014"),
                         round(ABILENE_INCOME_2014 * 1000 / ABILENE_POPULATION_2014))
        self.assertEqual(value_of(out, "33860", "bea_income_per_capita", "2014"), 40_270)
        out = roll(period="2024")
        self.assertEqual(value_of(out, "10180", "bea_income_per_capita", "2024"), ABILENE_PER_CAPITA_2024)
        self.assertEqual(value_of(out, "33860", "bea_income_per_capita", "2024"), 50_000)

    def test_division_inside_a_cbsa_gets_its_own_rollup(self):
        out = roll()
        self.assertEqual(value_of(out, "16984", "bea_personal_income", "2014"), DIVISION_INCOME_2014)
        self.assertEqual(value_of(out, "16984", "bea_population", "2014"), DIVISION_POPULATION_2014)
        self.assertEqual(value_of(out, "16984", "bea_income_per_capita", "2014"), DIVISION_PER_CAPITA_2014)
        self.assertEqual(value_of(out, "16980", "bea_personal_income", "2014"), MSA_INCOME_2014)
        self.assertEqual(value_of(out, "16980", "bea_population", "2014"), MSA_POPULATION_2014)
        self.assertEqual(value_of(out, "16980", "bea_income_per_capita", "2014"), MSA_PER_CAPITA_2014)
        self.assertNotEqual(value_of(out, "16984", "bea_income_per_capita", "2014"),
                            value_of(out, "16980", "bea_income_per_capita", "2014"))

    def test_per_capita_rounds_half_up_to_the_dollar(self):
        self.assertEqual(bea.per_capita(6_500_000, 153_500), 42_345)
        self.assertEqual(bea.per_capita(3, 2000), 2)
        self.assertEqual(bea.per_capita(5, 2000), 3)
        self.assertEqual(bea.per_capita(1, 1), 1000)
        self.assertEqual(bea.per_capita(7.0, 3.0), 2333)
        self.assertIsInstance(bea.per_capita(7, 3), int)

    def test_per_capita_is_none_without_people(self):
        self.assertIsNone(bea.per_capita(5, 0))
        self.assertIsNone(bea.per_capita(5, None))
        self.assertIsNone(bea.per_capita(None, 5))
        self.assertIsNone(bea.per_capita(float("nan"), 5))
        self.assertIsNone(bea.per_capita(5, float("nan")))

    # a county counts only when both lines carry a value, so callahan's income
    # leaves abilene along with its missing population
    def test_county_with_income_but_no_population_row_is_dropped_from_every_metric(self):
        values = {k: v for k, v in VALUES.items() if k != ("48059", "2014")}
        values[("48059", "2014")] = ("500,000", "(NA)")
        out = roll(values)
        self.assertEqual(value_of(out, "10180", "bea_personal_income", "2014"), 6_000_000)
        self.assertEqual(value_of(out, "10180", "bea_population", "2014"), 140_000)
        self.assertEqual(value_of(out, "10180", "bea_income_per_capita", "2014"), round(6_000_000_000 / 140_000))

    def test_county_with_population_but_no_income_row_is_dropped_from_every_metric(self):
        values = dict(VALUES)
        del values[("48059", "2014")]
        values[("48059", "2014")] = ("(D)", "13,500")
        out = roll(values)
        self.assertEqual(value_of(out, "10180", "bea_population", "2014"), 140_000)
        self.assertEqual(value_of(out, "10180", "bea_personal_income", "2014"), 6_000_000)

    def test_zero_population_county_is_unavailable(self):
        values = dict(VALUES)
        values[("48059", "2014")] = ("500,000", "0")
        out = roll(values)
        self.assertEqual(value_of(out, "10180", "bea_population", "2014"), 140_000)
        self.assertEqual(value_of(out, "10180", "bea_personal_income", "2014"), 6_000_000)
        values[("48441", "2014")] = ("6,000,000", "0")
        out = roll(values)
        self.assertNotIn("10180", set(out.cbsa_code))
        self.assertIn("16980", set(out.cbsa_code))

    def test_county_in_no_cbsa_is_ignored(self):
        out = roll()
        self.assertEqual(set(out.cbsa_code), {"10180", "16980", "16984", "33860"})
        self.assertEqual(int(out[out.metric == "bea_population"].value.sum()),
                         ABILENE_POPULATION_2014 + MSA_POPULATION_2014 + DIVISION_POPULATION_2014 + 55_000)

    # cook is repeated with another value and a flagged value: the first counts once
    def test_duplicate_rows_count_once(self):
        income = bea.parse_counties(income_rows() + [row("17031", "2014", "999"), row("17031", "2014", "(D)")])
        population = bea.parse_counties(population_rows() + [row("17031", "2014", "1", "2")])
        out = bea.rollup(bea.pair_lines(income, population, "2014"), crosswalk(), "2014")
        self.assertEqual(value_of(out, "16984", "bea_personal_income", "2014"), DIVISION_INCOME_2014)
        self.assertEqual(value_of(out, "16984", "bea_population", "2014"), DIVISION_POPULATION_2014)

    # autauga arrives as 01001 and must meet the crosswalk's 01001
    def test_leading_zero_fips_matches_the_crosswalk(self):
        out = roll()
        self.assertEqual(value_of(out, "33860", "bea_personal_income", "2014"), 2_214_858)
        self.assertEqual(value_of(out, "33860", "bea_population", "2014"), 55_000)

    def test_all_counties_suppressed_for_a_year_gives_no_row(self):
        values = dict(VALUES)
        values[("48441", "2014")] = ("(NA)", "140,000")
        values[("48059", "2014")] = ("(D)", "(D)")
        out = roll(values)
        self.assertNotIn("10180", set(out.cbsa_code))
        self.assertIn("16984", set(out.cbsa_code))
        self.assertEqual(value_of(roll(values, "2024"), "10180", "bea_personal_income", "2024"), ABILENE_INCOME_2024)

    def test_empty_input_gives_empty_frame_with_columns(self):
        empty = bea.parse_counties([])
        paired = bea.pair_lines(empty, empty, "2014")
        self.assertEqual(list(paired.columns), ["county_fips", "bea_personal_income", "bea_population"])
        out = bea.rollup(paired, crosswalk(), "2014")
        self.assertEqual(list(out.columns), bea.COLUMNS)
        self.assertEqual(len(out), 0)
        out = roll(period="2019")
        self.assertEqual(len(out), 0)

    def test_map_contract_columns_and_types(self):
        out = roll()
        self.assertEqual(list(out.columns), bea.COLUMNS)
        self.assertEqual(set(out.period), {"2014"})
        self.assertEqual(out.value.dtype.kind, "i")
        self.assertEqual(set(out.metric), set(bea.METRICS))
        self.assertEqual(list(zip(out.cbsa_code, out.metric))[:3],
                         [("10180", "bea_income_per_capita"), ("10180", "bea_personal_income"), ("10180", "bea_population")])

    def test_metric_names_are_not_reserved(self):
        self.assertFalse(set(bea.METRICS) & bm.RESERVED)
        for metric in bea.METRICS:
            self.assertTrue(metric.startswith("bea_"))
            self.assertEqual(metric, metric.lower())

    # the sums go through irs.aggregate under borrowed column names
    def test_aggregate_reuses_irs_and_returns_only_bea_names(self):
        paired = bea.pair_lines(bea.parse_counties(income_rows()), bea.parse_counties(population_rows()), "2014")
        with mock.patch.object(irs, "aggregate", wraps=irs.aggregate) as spy:
            out = bea.aggregate(paired, crosswalk(), "2014")
        self.assertEqual(spy.call_count, 1)
        self.assertEqual(set(out.metric), set(bea.SUMMED))
        self.assertFalse(set(out.metric) & set(irs.METRICS))
        self.assertEqual(value_of(out, "10180", "bea_personal_income", "2014"), ABILENE_INCOME_2014)


class TestBeaCombinedAreas(unittest.TestCase):
    def walk(self):
        return pd.DataFrame({
            "county_fips": ["51003", "51540", "51065", "51059", "51600", "51610", "51059", "51600", "51610", "48441"],
            "cbsa_code": ["16820", "16820", "16820", "47900", "47900", "47900", "11694", "11694", "11694", "10180"],
        })

    # albemarle and charlottesville city are one bea area, 51901, inside
    # charlottesville 16820. fairfax and its two cities sit in the washington
    # msa and its virginia division, so 51919 takes both codes
    def test_combined_code_takes_the_codes_its_parts_share(self):
        walk = bea.extend_crosswalk(self.walk())
        pairs = set(zip(walk.county_fips, walk.cbsa_code))
        self.assertIn(("51901", "16820"), pairs)
        self.assertEqual({code for fips, code in pairs if fips == "51919"}, {"47900", "11694"})
        self.assertTrue(set(zip(self.walk().county_fips, self.walk().cbsa_code)) <= pairs)
        self.assertEqual(list(walk.columns), ["county_fips", "cbsa_code"])

    def test_combined_area_outside_any_cbsa_adds_nothing(self):
        walk = bea.extend_crosswalk(self.walk())
        self.assertNotIn("51903", set(walk.county_fips))
        self.assertEqual(len(walk), len(self.walk()) + 1 + 2)

    def test_parts_in_different_cbsas_raise(self):
        split = pd.concat([self.walk(), pd.DataFrame({"county_fips": ["51540"], "cbsa_code": ["99999"]})])
        with self.assertRaises(RuntimeError) as ctx:
            bea.extend_crosswalk(split)
        self.assertIn("51901", str(ctx.exception))
        half = self.walk()[self.walk().county_fips != "51540"]
        with self.assertRaises(RuntimeError):
            bea.extend_crosswalk(half)

    def test_combined_values_land_in_the_cbsa(self):
        values = {("51901", "2024"): ("10,000,000", "200,000"), ("51065", "2024"): ("1,000,000", "30,000")}
        out = roll(values, "2024", bea.extend_crosswalk(self.walk()))
        self.assertEqual(value_of(out, "16820", "bea_personal_income", "2024"), 11_000_000)
        self.assertEqual(value_of(out, "16820", "bea_population", "2024"), 230_000)
        self.assertEqual(value_of(out, "16820", "bea_income_per_capita", "2024"), round(11_000_000_000 / 230_000))

    def test_combined_table_is_well_formed(self):
        parts = [p for group in bea.COMBINED.values() for p in group]
        self.assertEqual(len(parts), len(set(parts)))
        self.assertFalse(set(parts) & set(bea.COMBINED))
        for code in list(bea.COMBINED) + parts:
            self.assertEqual(bea.county_fips(code), code)
        for combined, group in bea.COMBINED.items():
            self.assertTrue(all(p[:2] == combined[:2] for p in group), combined)
            self.assertGreaterEqual(len(group), 2)


class TestBeaFiles(unittest.TestCase):
    def test_redact_removes_the_key_in_any_case(self):
        text = f"url: /api/data?UserID={FAKE_KEY.lower()}&x=1 and {FAKE_KEY}"
        out = bea.redact(text, FAKE_KEY)
        self.assertNotIn(FAKE_KEY.lower(), out.lower())
        self.assertEqual(out.count("REDACTED"), 2)

    def test_redact_with_no_key_leaves_text_alone(self):
        self.assertEqual(bea.redact("plain", ""), "plain")
        self.assertEqual(bea.redact(RuntimeError("boom"), None), "boom")

    def test_trim_payload_keeps_only_the_years_used(self):
        original = payload(income_rows() + [row("48441", "2013", "1"), row("48441", "2025", "2")])
        trimmed = bea.trim_payload(original, ["2014", "2024"])
        self.assertEqual(len(trimmed["BEAAPI"]["Results"]["Data"]), len(VALUES))
        self.assertEqual({r["TimePeriod"] for r in trimmed["BEAAPI"]["Results"]["Data"]}, {"2014", "2024"})
        self.assertEqual(trimmed["BEAAPI"]["Results"]["Notes"], original["BEAAPI"]["Results"]["Notes"])
        self.assertEqual(len(original["BEAAPI"]["Results"]["Data"]), len(VALUES) + 2)
        self.assertEqual(len(bea.trim_payload(original, [2014])["BEAAPI"]["Results"]["Data"]), 7)

    def test_merge_payloads_appends_probe_rows_to_the_bulk_response(self):
        bulk = payload(income_rows())
        probe = payload([row("48441", "2026", "5")], years="2026")
        merged = bea.merge_payloads([bulk, probe])
        self.assertEqual(len(merged["BEAAPI"]["Results"]["Data"]), len(VALUES) + 1)
        self.assertEqual(merged["BEAAPI"]["Request"], bulk["BEAAPI"]["Request"])
        self.assertEqual(len(bulk["BEAAPI"]["Results"]["Data"]), len(VALUES))

    def test_write_metrics_whole_numbers_and_leading_zeros_survive(self):
        df = pd.DataFrame({"cbsa_code": ["01234", "10180"], "metric": ["m", "m"],
                           "period": ["2024", "2024"], "value": [7116829.0, 42345.0]})
        with tempfile.TemporaryDirectory() as tmp:
            path = bea.write_metrics(df, Path(tmp) / "metrics.csv")
            text = path.read_text()
            back = pd.read_csv(path, dtype={"cbsa_code": str})
        self.assertEqual(text.splitlines()[0], "cbsa_code,metric,period,value")
        self.assertIn("01234,m,2024,7116829\n", text)
        self.assertNotIn(".0", text)
        self.assertEqual(back.cbsa_code.tolist(), ["01234", "10180"])
        self.assertEqual(back.value.tolist(), [7116829, 42345])


class TestBeaCollect(unittest.TestCase):
    def run_collect(self, responses, key=FAKE_KEY, walk="fixture"):
        calls = []
        with ExitStack() as stack:
            tmp = Path(stack.enter_context(tempfile.TemporaryDirectory()))
            out_dir = tmp / "bea"
            stack.enter_context(mock.patch.dict(os.environ, {"BEA_API_KEY": key}))
            stack.enter_context(mock.patch.object(bea, "OUT_DIR", out_dir))
            stack.enter_context(mock.patch.object(bea, "PAUSE_SECONDS", 0))
            stack.enter_context(mock.patch.object(bea, "this_year", lambda: THIS_YEAR))
            stack.enter_context(mock.patch.object(bea, "fetch", fake_fetch(responses, calls)))
            if walk == "fixture":
                stack.enter_context(mock.patch.object(bea, "load_crosswalk", crosswalk))
            output = io.StringIO()
            with redirect_stdout(output):
                result = bea.collect()
            files = {p.name: p.read_text() for p in out_dir.glob("*")} if out_dir.exists() else {}
        return result, calls, output.getvalue(), files

    def test_no_key_skips_without_touching_the_network(self):
        def never(*args, **kwargs):
            raise AssertionError("fetch must not run without a key")
        with mock.patch.object(bea, "load_crosswalk", never):
            result, calls, text, files = self.run_collect({}, key="", walk="real")
        self.assertIsNone(result)
        self.assertIn("skipping", text)
        self.assertEqual(text.count("\n"), 1)
        self.assertEqual(calls, [])
        self.assertEqual(files, {})

    def test_whitespace_key_counts_as_unset(self):
        result, calls, text, files = self.run_collect(good_responses(), key="   ")
        self.assertIsNone(result)
        self.assertEqual(calls, [])

    def test_collect_writes_metrics_manifest_and_redacted_raw(self):
        result, calls, text, files = self.run_collect(good_responses())
        self.assertEqual(result.name, "metrics.csv")
        self.assertEqual(set(files), {"metrics.csv", "download_manifest.json", "cainc1_line1.json", "cainc1_line2.json"})

        metrics = pd.read_csv(io.StringIO(files["metrics.csv"]), dtype={"cbsa_code": str, "period": str})
        self.assertEqual(list(metrics.columns), ["cbsa_code", "metric", "period", "value"])
        self.assertEqual(len(metrics), 4 * 3 * 2)
        self.assertEqual(sorted(metrics.metric.unique()), sorted(bea.METRICS))
        self.assertEqual(sorted(metrics.period.unique()), ["2014", "2024"])
        abi = metrics[metrics.cbsa_code == "10180"].set_index(["metric", "period"]).value
        self.assertEqual(abi[("bea_personal_income", "2014")], ABILENE_INCOME_2014)
        self.assertEqual(abi[("bea_population", "2024")], ABILENE_POPULATION_2024)
        self.assertEqual(abi[("bea_income_per_capita", "2024")], ABILENE_PER_CAPITA_2024)
        self.assertIn("10180,bea_personal_income,2014,6500000\n", files["metrics.csv"])
        self.assertIn(f"16984,bea_personal_income,2024,{DIVISION_INCOME_2024}\n", files["metrics.csv"])

        manifest = json.loads(files["download_manifest.json"])
        self.assertEqual([m["filename"] for m in manifest], ["metrics.csv", "cainc1_line1.json", "cainc1_line2.json"])
        self.assertEqual(manifest[0]["version"], "CAINC1 county rollup, 2014 through 2024")
        self.assertEqual(manifest[0]["integrity"]["row_count"], 24)
        self.assertEqual(manifest[0]["notes"]["cbsa_codes"], 4)
        self.assertEqual(manifest[0]["notes"]["metrics"]["bea_personal_income"]["unit"], "Thousands of dollars")
        self.assertEqual(manifest[0]["notes"]["next_year_probed"], "2026 not published")
        self.assertIn("GeoFips=COUNTY", manifest[0]["source"]["endpoint"])
        self.assertEqual(manifest[1]["notes"]["year_requests"], [BULK])
        self.assertEqual(manifest[1]["notes"]["unit_mult"], "3")
        self.assertEqual(manifest[2]["integrity"]["row_count"], len(VALUES))

        for line in ("1", "2"):
            raw = json.loads(files[f"cainc1_line{line}.json"])
            self.assertEqual(len(raw["BEAAPI"]["Results"]["Data"]), len(VALUES))
            echo = {p["ParameterName"]: p["ParameterValue"] for p in raw["BEAAPI"]["Request"]["RequestParam"]}
            self.assertEqual(echo["USERID"], "REDACTED")
            self.assertEqual(echo["YEAR"], BULK)
        for name, body in files.items():
            self.assertNotIn(FAKE_KEY.lower(), body.lower(), name)
        self.assertNotIn(FAKE_KEY.lower(), text.lower())

    def test_requests_carry_the_key_and_the_documented_parameters(self):
        _, calls, _, _ = self.run_collect(good_responses())
        self.assertEqual([(c["LineCode"], c["Year"]) for c in calls], [("1", BULK), ("2", BULK), ("1", "2026")])
        for call in calls:
            self.assertEqual((call["UserID"], call["datasetname"], call["ResultFormat"]), (FAKE_KEY, "Regional", "json"))
            self.assertEqual((call["method"], call["TableName"], call["GeoFips"]), ("GetData", "CAINC1", "COUNTY"))
            self.assertNotIn("ALL", call["Year"])
        self.assertEqual(calls[0]["Year"], "2014,2015,2016,2017,2018,2019,2020,2021,2022,2023,2024,2025")

    # bea has the calendar year: both lines are fetched, the next year is
    # tried and the run stops at its error 101
    def test_probe_forward_adds_a_published_year(self):
        responses = good_responses()
        later = {("48441", "2026"): ("9,900,000", "151,000"), ("48059", "2026"): ("900,000", "15,000")}
        responses["1:2026"] = FakeResponse(payload(income_rows(later), "1", years="2026"))
        responses["2:2026"] = FakeResponse(payload(population_rows(later), "2", years="2026"))
        result, calls, text, files = self.run_collect(responses)
        self.assertEqual([(c["LineCode"], c["Year"]) for c in calls],
                         [("1", BULK), ("2", BULK), ("1", "2026"), ("2", "2026"), ("1", "2027")])
        manifest = json.loads(files["download_manifest.json"])
        self.assertEqual(manifest[0]["version"], "CAINC1 county rollup, 2014 through 2026")
        self.assertEqual(manifest[0]["notes"]["next_year_probed"], "2027 not published")
        self.assertEqual(manifest[1]["notes"]["year_requests"], [BULK, "2026"])
        self.assertIn("10180,bea_personal_income,2026,10800000\n", files["metrics.csv"])
        self.assertIn(f"10180,bea_income_per_capita,2026,{round(10_800_000_000 / 166_000)}\n", files["metrics.csv"])
        raw = json.loads(files["cainc1_line2.json"])
        self.assertEqual(len(raw["BEAAPI"]["Results"]["Data"]), len(VALUES) + 2)
        self.assertEqual(manifest[2]["integrity"]["row_count"], len(VALUES) + 2)

    # line 1 has the year but line 2 answers 101: the year is not used at all
    def test_probe_stops_when_only_one_line_has_the_year(self):
        responses = good_responses()
        responses["1:2026"] = FakeResponse(payload([row("48441", "2026", "9,900,000")], "1", years="2026"))
        result, calls, text, files = self.run_collect(responses)
        self.assertEqual([(c["LineCode"], c["Year"]) for c in calls],
                         [("1", BULK), ("2", BULK), ("1", "2026"), ("2", "2026")])
        manifest = json.loads(files["download_manifest.json"])
        self.assertEqual(manifest[0]["version"], "CAINC1 county rollup, 2014 through 2024")
        self.assertNotIn("2026", files["metrics.csv"])
        raw = json.loads(files["cainc1_line1.json"])
        self.assertEqual({r["TimePeriod"] for r in raw["BEAAPI"]["Results"]["Data"]}, {"2014", "2024"})

    def test_probe_with_no_rows_stops_too(self):
        responses = good_responses()
        responses["1:2026"] = FakeResponse(payload([], "1", years="2026"))
        _, calls, _, files = self.run_collect(responses)
        self.assertEqual([(c["LineCode"], c["Year"]) for c in calls], [("1", BULK), ("2", BULK), ("1", "2026")])
        self.assertEqual(json.loads(files["download_manifest.json"])[0]["version"], "CAINC1 county rollup, 2014 through 2024")

    def test_probe_error_other_than_101_raises(self):
        responses = good_responses()
        responses["1:2026"] = FakeResponse(error_payload("3", f"The BEA API UserID provided is not valid: {FAKE_KEY}"))
        with self.assertRaises(RuntimeError) as ctx:
            self.run_collect(responses)
        self.assertIn("not valid", str(ctx.exception))
        self.assertNotIn(FAKE_KEY.lower(), str(ctx.exception).lower())

    def test_bulk_request_error_101_is_not_swallowed(self):
        responses = good_responses()
        responses[f"2:{BULK}"] = FakeResponse(error_payload())
        with self.assertRaises(bea.ApiError) as ctx:
            self.run_collect(responses)
        self.assertEqual(ctx.exception.code, "101")

    # a requests error carries the full url, key included, in its message
    def test_connection_error_never_carries_the_key(self):
        responses = good_responses()
        responses[f"1:{BULK}"] = requests.ConnectionError(
            f"Max retries exceeded with url: /api/data?UserID={FAKE_KEY}&method=GetData")
        with self.assertRaises(RuntimeError) as ctx:
            self.run_collect(responses)
        self.assertNotIn(FAKE_KEY.lower(), str(ctx.exception).lower())
        self.assertIn("REDACTED", str(ctx.exception))
        self.assertIsNone(ctx.exception.__cause__)

    def test_http_error_status_raises(self):
        responses = good_responses()
        responses[f"2:{BULK}"] = FakeResponse({}, status=429)
        with self.assertRaises(RuntimeError) as ctx:
            self.run_collect(responses)
        self.assertIn("429", str(ctx.exception))

    def test_non_json_body_raises(self):
        responses = good_responses()
        responses[f"1:{BULK}"] = FakeResponse(None, json_ok=False)
        with self.assertRaises(RuntimeError) as ctx:
            self.run_collect(responses)
        self.assertIn("json", str(ctx.exception))

    def test_changed_unit_stops_the_run(self):
        responses = good_responses()
        rows = population_rows() + [dict(row("48441", "2019", "150", "2"), CL_UNIT="Thousands of persons", UNIT_MULT="3")]
        responses[f"2:{BULK}"] = FakeResponse(payload(rows, "2"))
        with self.assertRaises(RuntimeError) as ctx:
            self.run_collect(responses)
        self.assertIn("UNIT_MULT", str(ctx.exception))

    def test_no_rows_in_the_window_raises(self):
        responses = good_responses()
        responses[f"1:{BULK}"] = FakeResponse(payload([row("48441", "2010", "1")], "1"))
        with self.assertRaises(RuntimeError) as ctx:
            self.run_collect(responses)
        self.assertIn("no CAINC1", str(ctx.exception))

    def test_empty_bulk_data_raises(self):
        responses = good_responses()
        responses[f"2:{BULK}"] = FakeResponse(payload([], "2"))
        with self.assertRaises(RuntimeError):
            self.run_collect(responses)

    # the real crosswalk path: the workbook is downloaded, parsed by the irs
    # helper and extended with the combined areas
    def test_crosswalk_comes_from_the_delineation_workbook(self):
        responses = good_responses()
        responses["delineation"] = FakeResponse(content=workbook([
            county_row("10180", None, "Callahan County", "48", "059"),
            county_row("10180", None, "Taylor County", "48", "441"),
            county_row("16980", "16984", "Cook County", "17", "031"),
            county_row("16820", None, "Albemarle County", "51", "003"),
            county_row("16820", None, "Charlottesville city", "51", "540"),
            ["Note: OMB standards", None, None, None, None, None, None, None, None, None, None, None],
        ]))
        values = dict(VALUES)
        values[("51901", "2024")] = ("10,000,000", "200,000")
        responses[f"1:{BULK}"] = FakeResponse(payload(income_rows(values), "1"))
        responses[f"2:{BULK}"] = FakeResponse(payload(population_rows(values), "2"))
        _, calls, _, files = self.run_collect(responses, walk="real")
        self.assertIn("10180,bea_personal_income,2014,6500000\n", files["metrics.csv"])
        self.assertIn("16984,bea_population,2014,5200000\n", files["metrics.csv"])
        self.assertIn("16820,bea_income_per_capita,2024,50000\n", files["metrics.csv"])
        self.assertNotIn("33860", files["metrics.csv"])
        self.assertEqual(len(calls), 3)

    def test_missing_delineation_raises_before_any_bea_request(self):
        responses = good_responses()
        responses["delineation"] = FakeResponse(status=404)
        with self.assertRaises(RuntimeError) as ctx:
            self.run_collect(responses, walk="real")
        self.assertIn("404", str(ctx.exception))

    def test_one_line_is_printed_per_written_file(self):
        _, _, text, _ = self.run_collect(good_responses())
        lines = [l for l in text.splitlines() if l.startswith("[bea]")]
        self.assertTrue(any("cainc1_line1.json" in l for l in lines))
        self.assertTrue(any("cainc1_line2.json" in l for l in lines))
        self.assertTrue(any("2026 is not published" in l for l in lines))
        self.assertTrue(lines[-1].endswith("metrics.csv"))


class TestBeaFeedsTheBuilder(unittest.TestCase):
    def frames(self):
        merged = pd.DataFrame({
            "cbsa_code": ["16984", "10180"],
            "place_name": ["Chicago-Naperville-Schaumburg, IL (MSAD)", "Abilene, TX"],
            "year": [2024, 2024], "avg_index_nsa": [260.0, 335.5],
            "geo_level": ["division", "msa"], "parent_cbsa": ["16980", None],
        })
        centroids = pd.DataFrame({
            "cbsa_code": ["16980", "16984", "10180"],
            "name": ["Chicago-Naperville-Elgin, IL-IN Metro Area", "Chicago-Naperville-Schaumburg, IL Metro Division", "Abilene, TX Metro Area"],
            "lat": [41.8, 41.85, 32.45], "lon": [-87.9, -87.95, -99.7],
        }).set_index("cbsa_code")
        return merged, centroids

    # the metrics.csv the collector writes lands in the year panels and latest,
    # and the chicago division carries its own rollup rather than the metro's
    def test_metrics_reach_abilene_and_the_division_has_its_own_rollup(self):
        merged, centroids = self.frames()
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "bea"
            with ExitStack() as stack:
                stack.enter_context(mock.patch.dict(os.environ, {"BEA_API_KEY": FAKE_KEY}))
                stack.enter_context(mock.patch.object(bea, "OUT_DIR", out_dir))
                stack.enter_context(mock.patch.object(bea, "PAUSE_SECONDS", 0))
                stack.enter_context(mock.patch.object(bea, "this_year", lambda: THIS_YEAR))
                stack.enter_context(mock.patch.object(bea, "fetch", fake_fetch(good_responses(), [])))
                stack.enter_context(mock.patch.object(bea, "load_crosswalk", crosswalk))
                with redirect_stdout(io.StringIO()):
                    bea.collect()
            enrichments = bm.discover_enrichments(tmp)
            self.assertEqual(enrichments[0]["metrics"], ["bea_income_per_capita", "bea_personal_income", "bea_population"])
            metros, _, _ = bm.build_metros(merged, centroids, enrichments=enrichments)
            self.assertEqual(bm.enrichment_version(out_dir), "CAINC1 county rollup, 2014 through 2024")
        abi = next(m for m in metros if m["cbsa"] == "10180")
        self.assertEqual(abi["years"]["2014"]["bea_personal_income"], float(ABILENE_INCOME_2014))
        self.assertEqual(abi["years"]["2014"]["bea_income_per_capita"], float(ABILENE_PER_CAPITA_2014))
        self.assertEqual(abi["years"]["2024"]["bea_population"], float(ABILENE_POPULATION_2024))
        self.assertIsNone(abi["years"]["2019"]["bea_income_per_capita"])
        self.assertEqual((abi["latest"]["bea_income_per_capita"], abi["latest"]["bea_income_per_capita_date"]),
                         (float(ABILENE_PER_CAPITA_2024), "2024"))
        self.assertEqual(abi["parent_metrics"], [])
        chi = next(m for m in metros if m["cbsa"] == "16984")
        self.assertEqual(chi["years"]["2024"]["bea_personal_income"], float(DIVISION_INCOME_2024))
        self.assertEqual(chi["years"]["2014"]["bea_income_per_capita"], float(DIVISION_PER_CAPITA_2014))
        self.assertNotEqual(chi["years"]["2014"]["bea_income_per_capita"], float(MSA_PER_CAPITA_2014))
        self.assertEqual(chi["parent_metrics"], [])


if __name__ == "__main__":
    unittest.main()


class TestStableRawFile(unittest.TestCase):
    # the committed raw file must not change when only bea's clock does
    def test_trim_drops_the_production_stamp(self):
        payload = {"BEAAPI": {"Request": {}, "Results": {"UTCProductionTime": "2026-09-15T17:00:00", "Data": [
            {"GeoFips": "48441", "TimePeriod": "2024", "DataValue": "1"}]}}}
        trimmed = bea.trim_payload(payload, [2024])
        self.assertNotIn("UTCProductionTime", trimmed["BEAAPI"]["Results"])
        self.assertEqual(len(trimmed["BEAAPI"]["Results"]["Data"]), 1)
        self.assertIn("UTCProductionTime", payload["BEAAPI"]["Results"])  # the input is untouched

import tempfile
import unittest
from pathlib import Path

import pandas as pd

from bot import build_map_data
from bot.collectors import pep

MSA = "Metropolitan Statistical Area"
MICRO = "Micropolitan Statistical Area"
DIV = "Metropolitan Division"
COUNTY = "County or equivalent"

# the vintage 2025 layout trimmed to the columns the collector reads plus a
# few it must ignore. abilene with one county, chicago with its division and
# one county, aberdeen as a micro area. abilene is the real file
V2025 = (
    "CBSA,MDIV,STCOU,NAME,LSAD,ESTIMATESBASE2020,POPESTIMATE2020,POPESTIMATE2021,"
    "NPOPCHG2020,NPOPCHG2021,NATURALCHG2020,NATURALCHG2021,INTERNATIONALMIG2020,"
    "INTERNATIONALMIG2021,DOMESTICMIG2020,DOMESTICMIG2021,NETMIG2020,NETMIG2021\n"
    f'10180,,,"Abilene, TX",{MSA},176594,176899,177942,305,1043,66,-196,2,144,193,1022,195,1166\n'
    f'10180,,48059,"Callahan County, TX",{COUNTY},13706,13748,14104,42,356,-22,-103,0,0,69,481,69,481\n'
    f'16980,,,"Chicago-Naperville-Elgin, IL-IN",{MSA},9509934,9506035,9459337,-3899,-46698,'
    "11784,7530,12002,17840,-27685,-72118,-15683,-54278\n"
    f'16980,16984,,"Chicago-Naperville-Schaumburg, IL",{DIV},7248543,7245026,7192112,-3517,-52914,'
    "9061,4886,10371,15521,-22949,-73321,-12578,-57800\n"
    f'16980,16984,17031,"Cook County, IL",{COUNTY},5275541,5270451,5202339,-5090,-68112,'
    "7000,3000,9000,13000,-21090,-84112,-12090,-71112\n"
    f'10100,,,"Aberdeen, SD",{MICRO},44013,44051,50000,38,175,50,60,10,20,-22,95,-12,115\n'
)

# the vintage 2019 layout: a census count, NATURALINC instead of NATURALCHG,
# and the 2010 base. abilene is the real file
V2019 = (
    "CBSA,MDIV,STCOU,NAME,LSAD,CENSUS2010POP,ESTIMATESBASE2010,POPESTIMATE2010,POPESTIMATE2011,"
    "POPESTIMATE2019,NPOPCHG2010,NPOPCHG2011,NPOPCHG2019,NATURALINC2010,NATURALINC2011,NATURALINC2019,"
    "DOMESTICMIG2010,DOMESTICMIG2011,DOMESTICMIG2019,NETMIG2010,NETMIG2011,NETMIG2019\n"
    f'10180,,,"Abilene, TX",{MSA},165252,165252,165585,166634,172060,333,1049,910,130,789,609,'
    "124,64,90,208,263,310\n"
    f'16980,16984,,"Chicago-Naperville-Evanston, IL",{DIV},7262718,7263145,7269843,7300000,7100000,'
    "6698,30157,-20000,25000,50000,30000,-10000,-40000,-60000,-10000,-30000,-50000\n"
)

# a short header for the edge cases
HEAD = ("CBSA,MDIV,STCOU,NAME,LSAD,ESTIMATESBASE2020,POPESTIMATE2020,POPESTIMATE2021,"
        "NATURALCHG2020,NATURALCHG2021,DOMESTICMIG2020,DOMESTICMIG2021,NETMIG2020,NETMIG2021\n")

# vintage 2019 rows for three codes omb has since renumbered, estimates only.
# the villages 45540 is 48680 today and gary 23844 is 29414, both on the same
# counties. cleveland 17460 is 17410, which also holds ashtabula. real figures
RENUMBERED_2019 = (
    "CBSA,MDIV,STCOU,NAME,LSAD,ESTIMATESBASE2010,POPESTIMATE2010,POPESTIMATE2014,POPESTIMATE2019\n"
    f'45540,,,"The Villages, FL",{MSA},93420,94278,112236,132420\n'
    f'45540,,12119,"Sumter County, FL",{COUNTY},93420,94278,112236,132420\n'
    f'16980,23844,,"Gary, IN",{DIV},708117,708163,705792,703428\n'
    f'17460,,,"Cleveland-Elyria, OH",{MSA},2077277,2075478,2067356,2048449\n'
)

# the same area in vintage 2025, printed under its current code, in the short
# header. the estimates are real, the components invented
VILLAGES_2025 = f'48680,,,"Wildwood-The Villages, FL",{MSA},129752,130293,134878,5,6,7,8,9,10'

MEMBERSHIP = Path(__file__).resolve().parent.parent / "data" / "raw" / "gazetteer" / "cbsa_counties_by_vintage.csv"


def csv(*rows):
    return HEAD + "".join(row + "\n" for row in rows)


def value(df, code, metric, period):
    rows = df[(df.cbsa_code == code) & (df.metric == metric) & (df.period == period)]
    return None if rows.empty else float(rows.value.iloc[0])


class TestParseVintage2025(unittest.TestCase):
    def setUp(self):
        self.df = pep.parse_vintage(V2025)

    def test_columns_and_dtypes(self):
        self.assertEqual(list(self.df.columns), ["cbsa_code", "metric", "period", "value"])
        self.assertEqual(self.df.value.dtype.kind, "f")
        self.assertTrue((self.df.period.str.len() == 4).all())

    def test_abilene_2021_exact(self):
        self.assertEqual(value(self.df, "10180", "pop_estimate", "2021"), 177942)
        self.assertEqual(value(self.df, "10180", "natural_change", "2021"), -196)
        self.assertEqual(value(self.df, "10180", "domestic_migration", "2021"), 1022)
        self.assertEqual(value(self.df, "10180", "net_migration", "2021"), 1166)
        self.assertEqual(value(self.df, "10180", "domestic_migration_rate", "2021"), 5.743)

    # 2020 is the base year: its july 1 estimate is real, its components only
    # cover april to june and are left out along with the base itself
    def test_base_year_keeps_population_but_not_components(self):
        self.assertEqual(value(self.df, "10180", "pop_estimate", "2020"), 176899)
        for metric in ("natural_change", "domestic_migration", "net_migration", "domestic_migration_rate"):
            self.assertIsNone(value(self.df, "10180", metric, "2020"), metric)
        self.assertNotIn(176594, self.df.value.tolist())

    def test_county_rows_dropped(self):
        self.assertEqual(sorted(self.df.cbsa_code.unique()), ["10100", "10180", "16980", "16984"])
        self.assertNotIn(14104, self.df.value.tolist())

    def test_division_keyed_by_mdiv_and_parent_by_cbsa(self):
        self.assertEqual(value(self.df, "16984", "pop_estimate", "2021"), 7192112)
        self.assertEqual(value(self.df, "16980", "pop_estimate", "2021"), 9459337)
        self.assertEqual(value(self.df, "16984", "domestic_migration_rate", "2021"), -10.195)

    def test_micro_area_kept_with_a_round_rate(self):
        self.assertEqual(value(self.df, "10100", "pop_estimate", "2021"), 50000)
        self.assertEqual(value(self.df, "10100", "domestic_migration_rate", "2021"), 1.9)

    # four areas, each with two estimates, three components and one rate
    def test_row_count_exact(self):
        self.assertEqual(len(self.df), 24)
        self.assertEqual(sorted(self.df.metric.unique()), sorted(pep.METRICS))

    def test_bytes_input_parses_the_same(self):
        again = pep.parse_vintage(V2025.encode("latin-1"))
        pd.testing.assert_frame_equal(again, self.df)


class TestParseVintage2019(unittest.TestCase):
    def setUp(self):
        self.df = pep.parse_vintage(V2019)

    def test_naturalinc_lands_as_natural_change(self):
        self.assertEqual(value(self.df, "10180", "natural_change", "2011"), 789)
        self.assertEqual(value(self.df, "10180", "natural_change", "2019"), 609)

    def test_2010_estimate_kept_and_base_skipped(self):
        self.assertEqual(value(self.df, "10180", "pop_estimate", "2010"), 165585)
        self.assertIsNone(value(self.df, "10180", "natural_change", "2010"))
        self.assertIsNone(value(self.df, "10180", "domestic_migration_rate", "2010"))

    def test_rates_exact(self):
        self.assertEqual(value(self.df, "10180", "domestic_migration_rate", "2019"), 0.523)
        self.assertEqual(value(self.df, "10180", "domestic_migration_rate", "2011"), 0.384)

    def test_only_the_five_metrics(self):
        self.assertEqual(sorted(self.df.metric.unique()), sorted(pep.METRICS))
        self.assertEqual(sorted(self.df.period.unique()), ["2010", "2011", "2019"])

    def test_division_under_the_old_delineation(self):
        self.assertEqual(value(self.df, "16984", "pop_estimate", "2019"), 7100000)
        self.assertEqual(value(self.df, "16984", "net_migration", "2019"), -50000)


class TestMergeVintages(unittest.TestCase):
    def frames(self):
        old = pep.parse_vintage(csv(f'10180,,,"Abilene, TX",{MSA},1,100,200,5,6,7,8,9,10'))
        new = pep.parse_vintage(csv(f'10180,,,"Abilene, TX",{MSA},1,101,,5,,7,,9,'))
        return old, new

    # a year both vintages carry takes the newer value, a year only the older
    # one carries survives
    def test_newer_vintage_wins_the_shared_year(self):
        old, new = self.frames()
        merged = pep.merge_vintages({2024: old, 2025: new})
        self.assertEqual(value(merged, "10180", "pop_estimate", "2020"), 101)
        self.assertEqual(value(merged, "10180", "pop_estimate", "2021"), 200)
        self.assertEqual(value(merged, "10180", "net_migration", "2021"), 10)

    def test_dict_order_does_not_matter(self):
        old, new = self.frames()
        merged = pep.merge_vintages({2025: new, 2024: old})
        self.assertEqual(value(merged, "10180", "pop_estimate", "2020"), 101)

    def test_no_duplicate_keys_after_merge(self):
        old, new = self.frames()
        merged = pep.merge_vintages({2024: old, 2025: new})
        self.assertFalse(merged.duplicated(["cbsa_code", "metric", "period"]).any())

    def test_output_sorted_by_code_metric_period(self):
        merged = pep.merge_vintages({2025: pep.parse_vintage(V2025), 2019: pep.parse_vintage(V2019)})
        keys = list(zip(merged.cbsa_code, merged.metric, merged.period))
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(sorted(merged.period.unique()), ["2010", "2011", "2019", "2020", "2021"])

    def test_no_frames_gives_empty_with_columns(self):
        merged = pep.merge_vintages({})
        self.assertEqual(list(merged.columns), pep.COLUMNS)
        self.assertEqual(len(merged), 0)


class TestEdgeCases(unittest.TestCase):
    def test_empty_text_and_empty_bytes(self):
        for content in ("", "   \n", b""):
            df = pep.parse_vintage(content)
            self.assertEqual(list(df.columns), pep.COLUMNS)
            self.assertEqual(len(df), 0)

    def test_header_only(self):
        df = pep.parse_vintage(HEAD)
        self.assertEqual(list(df.columns), pep.COLUMNS)
        self.assertEqual(len(df), 0)

    # a blank component drops that row and the rate that needs it, nothing else
    def test_missing_value_skips_row_and_rate(self):
        df = pep.parse_vintage(csv(f'10180,,,"Abilene, TX",{MSA},1,100,200,5,6,7,,9,10'))
        self.assertIsNone(value(df, "10180", "domestic_migration", "2021"))
        self.assertIsNone(value(df, "10180", "domestic_migration_rate", "2021"))
        self.assertEqual(value(df, "10180", "pop_estimate", "2021"), 200)
        self.assertEqual(value(df, "10180", "net_migration", "2021"), 10)
        self.assertFalse(df.value.isna().any())

    def test_non_numeric_value_is_skipped(self):
        df = pep.parse_vintage(csv(f'10180,,,"Abilene, TX",{MSA},1,100,X,5,6,7,8,9,10'))
        self.assertIsNone(value(df, "10180", "pop_estimate", "2021"))
        self.assertEqual(value(df, "10180", "pop_estimate", "2020"), 100)
        self.assertIsNone(value(df, "10180", "domestic_migration_rate", "2021"))

    def test_zero_population_gives_no_rate(self):
        df = pep.parse_vintage(csv(f'10180,,,"Abilene, TX",{MSA},1,100,0,5,6,7,8,9,10'))
        self.assertEqual(value(df, "10180", "pop_estimate", "2021"), 0)
        self.assertIsNone(value(df, "10180", "domestic_migration_rate", "2021"))

    def test_leading_zero_codes_survive_and_short_codes_are_padded(self):
        df = pep.parse_vintage(csv(
            f'01234,,,"Zero, ZZ",{MSA},1,100,200,5,6,7,8,9,10',
            f'1234,,,"Bare, ZZ",{MICRO},1,100,300,5,6,7,8,9,10',
            f'20000,987,,"Small Division, ZZ",{DIV},1,100,400,5,6,7,8,9,10',
        ))
        self.assertEqual(sorted(df.cbsa_code.unique()), ["00987", "01234"])
        # the two spellings of 1234 collapse to one code, the first row wins
        self.assertEqual(value(df, "01234", "pop_estimate", "2021"), 200)
        self.assertEqual(value(df, "00987", "pop_estimate", "2021"), 400)

    # a year with an estimate but no component columns yields the estimate only
    def test_year_without_component_columns(self):
        text = ("CBSA,MDIV,STCOU,NAME,LSAD,ESTIMATESBASE2020,POPESTIMATE2020,POPESTIMATE2021,POPESTIMATE2022,"
                "DOMESTICMIG2020,DOMESTICMIG2021\n"
                f'10180,,,"Abilene, TX",{MSA},1,100,200,300,7,8\n')
        df = pep.parse_vintage(text)
        self.assertEqual(value(df, "10180", "pop_estimate", "2022"), 300)
        self.assertEqual(value(df, "10180", "domestic_migration_rate", "2021"), 40)
        self.assertIsNone(value(df, "10180", "domestic_migration", "2022"))
        self.assertIsNone(value(df, "10180", "domestic_migration_rate", "2022"))
        self.assertNotIn("natural_change", df.metric.tolist())

    def test_year_with_blank_values_for_every_area(self):
        df = pep.parse_vintage(csv(
            f'10180,,,"Abilene, TX",{MSA},1,100,,5,6,7,8,9,10',
            f'10100,,,"Aberdeen, SD",{MICRO},1,100,,5,6,7,8,9,10',
        ))
        self.assertEqual(sorted(df[df.metric == "pop_estimate"].period.unique()), ["2020"])
        self.assertNotIn("domestic_migration_rate", df.metric.tolist())

    def test_duplicate_code_in_one_file_keeps_the_first(self):
        df = pep.parse_vintage(csv(
            f'10180,,,"Abilene, TX",{MSA},1,100,200,5,6,7,8,9,10',
            f'10180,,,"Abilene again, TX",{MSA},1,100,999,5,6,7,8,9,10',
        ))
        self.assertEqual(value(df, "10180", "pop_estimate", "2021"), 200)
        self.assertEqual(len(df[df.metric == "pop_estimate"]), 2)

    def test_unknown_or_blank_lsad_dropped(self):
        df = pep.parse_vintage(csv(
            f'10180,,,"Abilene, TX",Combined Statistical Area,1,100,200,5,6,7,8,9,10',
            f'10190,,,"Blank, TX",,1,100,200,5,6,7,8,9,10',
            f'10100,,,"Aberdeen, SD",{MICRO},1,100,300,5,6,7,8,9,10',
        ))
        self.assertEqual(df.cbsa_code.unique().tolist(), ["10100"])

    def test_blank_code_dropped(self):
        df = pep.parse_vintage(csv(
            f',,,"No code, TX",{MSA},1,100,200,5,6,7,8,9,10',
            f'16980,,,"No division code, IL",{DIV},1,100,200,5,6,7,8,9,10',
            f'10100,,,"Aberdeen, SD",{MICRO},1,100,300,5,6,7,8,9,10',
        ))
        self.assertEqual(df.cbsa_code.unique().tolist(), ["10100"])

    def test_lsad_with_trailing_spaces_still_matches(self):
        df = pep.parse_vintage(csv(f'10180,,,"Abilene, TX",{MSA}  ,1,100,200,5,6,7,8,9,10'))
        self.assertEqual(value(df, "10180", "pop_estimate", "2021"), 200)

    # a truncated line keeps the fields it has, an overlong line is skipped
    def test_short_and_long_rows(self):
        df = pep.parse_vintage(csv(
            f'10180,,,"Abilene, TX",{MSA},1,100',
            f'10100,,,"Aberdeen, SD",{MICRO},1,100,300,5,6,7,8,9,10,11,12',
            f'16980,,,"Chicago, IL",{MSA},1,100,300,5,6,7,8,9,10',
        ))
        self.assertEqual(value(df, "10180", "pop_estimate", "2020"), 100)
        self.assertIsNone(value(df, "10180", "pop_estimate", "2021"))
        self.assertNotIn("10100", df.cbsa_code.tolist())
        self.assertEqual(value(df, "16980", "pop_estimate", "2021"), 300)

    def test_latin1_bytes_decode(self):
        content = HEAD.encode("latin-1") + (
            b'20000,,,"Espa\xf1ola, NM",Micropolitan Statistical Area,1,100,200,5,6,7,8,9,10\n')
        df = pep.parse_vintage(content)
        self.assertEqual(value(df, "20000", "pop_estimate", "2021"), 200)

    def test_missing_key_columns_raise(self):
        with self.assertRaises(ValueError):
            pep.parse_vintage("CBSA,NAME,POPESTIMATE2020\n10180,Abilene,1\n")

    # without a base column every year keeps its components
    def test_no_base_column_keeps_every_year(self):
        text = HEAD.replace("ESTIMATESBASE2020,", "") + f'10180,,,"Abilene, TX",{MSA},100,200,5,6,7,8,9,10\n'
        df = pep.parse_vintage(text)
        self.assertEqual(value(df, "10180", "natural_change", "2020"), 5)
        self.assertEqual(value(df, "10180", "domestic_migration_rate", "2020"), 70)


class TestRenumbered(unittest.TestCase):
    def test_a_retired_metro_code_lands_under_the_current_one(self):
        df = pep.parse_vintage(RENUMBERED_2019)
        self.assertEqual(value(df, "48680", "pop_estimate", "2014"), 112236)
        self.assertEqual(value(df, "48680", "pop_estimate", "2019"), 132420)
        self.assertNotIn("45540", df.cbsa_code.tolist())

    def test_a_retired_division_code_lands_under_the_current_one(self):
        df = pep.parse_vintage(RENUMBERED_2019)
        self.assertEqual(value(df, "29414", "pop_estimate", "2014"), 705792)
        self.assertNotIn("23844", df.cbsa_code.tolist())

    # ashtabula moved into 17410, so 17460 is not the same counties
    def test_a_code_that_moved_a_county_stays_where_it_was_printed(self):
        df = pep.parse_vintage(RENUMBERED_2019)
        self.assertEqual(value(df, "17460", "pop_estimate", "2014"), 2067356)
        self.assertNotIn("17410", df.cbsa_code.tolist())

    # the levels are kept as published, one vintage beside the other
    def test_the_two_vintages_meet_under_the_current_code(self):
        frames = {2019: pep.parse_vintage(RENUMBERED_2019), 2025: pep.parse_vintage(csv(VILLAGES_2025))}
        merged = pep.merge_vintages(frames)
        rows = merged[(merged.cbsa_code == "48680") & (merged.metric == "pop_estimate")]
        self.assertEqual(dict(zip(rows.period, rows.value)),
                         {"2010": 94278, "2014": 112236, "2019": 132420, "2020": 130293, "2021": 134878})
        self.assertNotIn("45540", merged.cbsa_code.tolist())

    # a file printing both codes keeps the row printed under the current one,
    # whichever comes first
    def test_the_current_code_wins_when_both_are_printed(self):
        retired = f'45540,,,"The Villages, FL",{MSA},1,999,999,5,6,7,8,9,10'
        for rows in ((retired, VILLAGES_2025), (VILLAGES_2025, retired)):
            df = pep.parse_vintage(csv(*rows))
            self.assertEqual(value(df, "48680", "pop_estimate", "2021"), 134878)
            self.assertEqual(len(df[df.metric == "pop_estimate"]), 2)

    def test_the_pairs_come_from_the_census_crosswalks(self):
        crosswalks = {**pep.MSA_CROSSWALK, **pep.DIVISION_CROSSWALK}
        self.assertEqual(pep.RENUMBERED, {old: new for old, new in crosswalks.items() if old not in pep.MOVED_A_COUNTY})
        self.assertEqual(pep.RENUMBERED["45540"], "48680")
        self.assertLessEqual(pep.MOVED_A_COUNTY, set(crosswalks))

    # the premise, from the delineations the gazetteer archived: a pair kept
    # holds the same counties under its old code, on every delineation that
    # lists it, as under its new code on the newest, and a pair left out does not
    def test_every_pair_kept_moved_no_county_and_every_pair_left_out_did(self):
        if not MEMBERSHIP.exists():
            self.skipTest("the gazetteer membership file is not on disk")
        membership = build_map_data.load_membership(MEMBERSHIP)
        newest = membership[max(membership)]
        crosswalks = {**pep.MSA_CROSSWALK, **pep.DIVISION_CROSSWALK}
        for old, new in crosswalks.items():
            listed = [table[old] for table in membership.values() if old in table]
            self.assertTrue(listed, old)
            same = all(counties == newest[new] for counties in listed)
            self.assertEqual(same, old in pep.RENUMBERED, f"{old} -> {new}")


class TestHelpers(unittest.TestCase):
    def test_vintage_urls(self):
        self.assertEqual(pep.vintage_url(2025), "https://www2.census.gov/programs-surveys/popest/datasets/"
                         "2020-2025/metro/totals/cbsa-est2025-alldata.csv")
        self.assertEqual(pep.vintage_url(2024), "https://www2.census.gov/programs-surveys/popest/datasets/"
                         "2020-2024/metro/totals/cbsa-est2024-alldata.csv")
        self.assertEqual(pep.vintage_url(2019), "https://www2.census.gov/programs-surveys/popest/datasets/"
                         "2010-2019/metro/totals/cbsa-est2019-alldata.csv")

    def test_base_year(self):
        self.assertEqual(pep.base_year(["CBSA", "ESTIMATESBASE2020", "POPESTIMATE2020"]), 2020)
        self.assertEqual(pep.base_year(["CENSUS2010POP", "ESTIMATESBASE2010"]), 2010)
        self.assertIsNone(pep.base_year(["CBSA", "POPESTIMATE2020"]))

    def test_year_columns_first_prefix_wins(self):
        cols = ["NATURALINC2010", "NATURALCHG2020", "NATURALCHG2021", "INTERNATIONALMIG2020", "NETMIG2020"]
        self.assertEqual(pep.year_columns(cols, ("NATURALCHG", "NATURALINC")),
                         {2020: "NATURALCHG2020", 2021: "NATURALCHG2021"})
        self.assertEqual(pep.year_columns(cols, ("NETMIG",)), {2020: "NETMIG2020"})
        self.assertEqual(pep.year_columns(cols, ("DOMESTICMIG",)), {})

    def test_metric_names_are_not_reserved(self):
        self.assertFalse(set(pep.METRICS) & build_map_data.RESERVED)
        for metric in pep.METRICS:
            self.assertRegex(metric, r"^[a-z][a-z_]*$")

    # counts are written whole, the rate keeps its decimals, and the builder
    # reads the file back
    def test_write_metrics_format_and_builder_roundtrip(self):
        df = pep.merge_vintages({2025: pep.parse_vintage(V2025)})
        with tempfile.TemporaryDirectory() as tmp:
            path = pep.write_metrics(df, Path(tmp) / "metrics.csv")
            lines = path.read_text().splitlines()
            self.assertEqual(lines[0], "cbsa_code,metric,period,value")
            self.assertIn("10180,pop_estimate,2021,177942", lines)
            self.assertIn("10180,domestic_migration_rate,2021,5.743", lines)
            self.assertIn("16984,domestic_migration_rate,2021,-10.195", lines)
            self.assertFalse(any(line.endswith(".0") for line in lines))
            loaded = build_map_data.load_enrichment(path)
        self.assertEqual(loaded["metrics"], sorted(pep.METRICS))
        annual, latest = build_map_data.enrich_values(loaded["groups"]["10180"])
        self.assertEqual(annual[("pop_estimate", 2021)], 177942)
        self.assertEqual(latest["domestic_migration_rate"], ("2021", 5.743))


if __name__ == "__main__":
    unittest.main()

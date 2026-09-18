import hashlib
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import pandas as pd

from bot import build_map_data
from bot.collectors import zillow_extras as zx

HEADER = "RegionID,SizeRank,RegionName,RegionType,StateName,2023-12-31,2024-01-31,2024-02-29,2025-01-31\n"

# a national row, a full metro, a metro with a gap, and a name no gazetteer row has
INVENTORY = (
    HEADER
    + "102001,0,United States,country,,900,1000,1100,1200\n"
    + '394299,251,"Abilene, TX",msa,TX,50,10,20,30\n'
    + '394463,3,"Chicago, IL",msa,IL,500,100,,300\n'
    + '999999,900,"Nowhere, ZZ",msa,ZZ,1,2,3,4\n'
)

FORECAST = (
    "RegionID,SizeRank,RegionName,RegionType,StateName,BaseDate,2026-08-31,2026-10-31,2027-07-31\n"
    "102001,0,United States,country,,2026-07-31,0.2,0.5,1.1\n"
    '394299,251,"Abilene, TX",msa,TX,2026-07-31,0.6,0.9,2.3\n'
    '394463,3,"Chicago, IL",msa,IL,2026-07-31,0.1,0.4,\n'
    '999999,900,"Nowhere, ZZ",msa,ZZ,2026-07-31,0.1,0.2,0.3\n'
)

GAZETTEER = pd.DataFrame({
    "cbsa_code": ["10180", "16980", "16984", "10100"],
    "name": [
        "Abilene, TX Metro Area",
        "Chicago-Naperville-Elgin, IL-IN Metro Area",
        "Chicago-Naperville-Schaumburg, IL Metro Division",
        "Aberdeen, SD Micro Area",
    ],
    "cbsa_type": [1, 1, 3, 2],
    "parent_cbsa": ["", "", "16980", ""],
})

MAPPING = {"Abilene, TX": "10180", "Chicago, IL": "16980"}


def frame(text):
    return zx.load_frame(text.encode())


def rows(df, code, metric=None):
    out = df[df.cbsa_code == code]
    if metric:
        out = out[out.metric == metric]
    return dict(zip(out.period, out.value))


class TestLoadFrame(unittest.TestCase):
    def test_country_row_dropped_and_names_indexed(self):
        df = frame(INVENTORY)
        self.assertEqual(df.index.tolist(), ["Abilene, TX", "Chicago, IL", "Nowhere, ZZ"])
        self.assertEqual(df.loc["Abilene, TX", "2024-01-31"], 10)

    def test_duplicate_name_keeps_first_row(self):
        text = HEADER + '1,1,"Abilene, TX",msa,TX,1,2,3,4\n' + '2,2,"Abilene, TX",msa,TX,9,9,9,9\n'
        df = frame(text)
        self.assertEqual(len(df), 1)
        self.assertEqual(df.loc["Abilene, TX", "2023-12-31"], 1)

    def test_header_only_is_empty(self):
        df = frame(HEADER)
        self.assertEqual(len(df), 0)
        self.assertIn("2025-01-31", df.columns)

    # a line with too many fields keeps its leading fields aligned with the
    # header and loses the extras, a short one is padded with blanks. without
    # index_col=False pandas would read the extras as index columns and shift
    # every column of every row
    def test_malformed_lines(self):
        text = HEADER + '1,1,"Abilene, TX",msa,TX,1,2,3,4,5,6\n' + '2,2,"Chicago, IL",msa,IL,7\n'
        with self.assertWarns(pd.errors.ParserWarning):
            df = frame(text)
        self.assertEqual(df.index.tolist(), ["Abilene, TX", "Chicago, IL"])
        self.assertEqual(df.loc["Abilene, TX", "2025-01-31"], 4)
        self.assertEqual(df.loc["Chicago, IL", "2023-12-31"], 7)
        self.assertTrue(pd.isna(df.loc["Chicago, IL", "2025-01-31"]))

    def test_missing_name_column_raises(self):
        with self.assertRaises(ValueError):
            zx.load_frame(b"RegionID,2024-01-31\n1,2\n")

    def test_blank_name_dropped(self):
        text = HEADER + "1,1,,msa,TX,1,2,3,4\n" + '2,2,"Abilene, TX",msa,TX,1,2,3,4\n'
        self.assertEqual(frame(text).index.tolist(), ["Abilene, TX"])


class TestMetroNames(unittest.TestCase):
    def test_suffix_stripped_and_divisions_left_out(self):
        self.assertEqual(zx.metro_names(GAZETTEER), [
            ("10180", "Abilene, TX"),
            ("16980", "Chicago-Naperville-Elgin, IL-IN"),
            ("10100", "Aberdeen, SD"),
        ])

    def test_empty_gazetteer(self):
        empty = pd.DataFrame(columns=["cbsa_code", "name", "cbsa_type"])
        self.assertEqual(zx.metro_names(empty), [])

    def test_codes_keep_leading_zero_as_strings(self):
        gaz = pd.DataFrame({"cbsa_code": ["01234"], "name": ["Somewhere, AK Micro Area"], "cbsa_type": [2]})
        self.assertEqual(zx.metro_names(gaz), [("01234", "Somewhere, AK")])


class TestMatchNames(unittest.TestCase):
    def test_first_city_matches_zillow_name(self):
        mapping = zx.match_names(zx.metro_names(GAZETTEER), ["Abilene, TX", "Chicago, IL", "Nowhere, ZZ"])
        self.assertEqual(mapping, MAPPING)

    def test_zillow_name_matching_nothing_is_absent(self):
        mapping = zx.match_names(zx.metro_names(GAZETTEER), ["Nowhere, ZZ"])
        self.assertEqual(mapping, {})

    def test_exact_name_preferred_over_first_city(self):
        names = ["Los Angeles, CA", "Los Angeles-Long Beach-Anaheim, CA"]
        mapping = zx.match_names([("31080", "Los Angeles-Long Beach-Anaheim, CA")], names)
        self.assertEqual(mapping, {"Los Angeles-Long Beach-Anaheim, CA": "31080"})

    # zillow still names some metros by an older delineation's later city
    def test_later_city_matches_when_first_does_not(self):
        mapping = zx.match_names([("48680", "Wildwood-The Villages, FL")], ["The Villages, FL"])
        self.assertEqual(mapping, {"The Villages, FL": "48680"})

    def test_first_code_keeps_a_contested_name(self):
        gaz = [("11111", "Springfield, MO Metro Area"), ("22222", "Springfield, MO Micro Area")]
        mapping = zx.match_names([(c, re.sub(r" (Metro|Micro) Area$", "", n)) for c, n in gaz], ["Springfield, MO"])
        self.assertEqual(mapping, {"Springfield, MO": "11111"})

    def test_each_code_claims_at_most_one_name(self):
        mapping = zx.match_names([("31080", "Los Angeles-Long Beach-Anaheim, CA")], ["Los Angeles, CA", "Anaheim, CA"])
        self.assertEqual(mapping, {"Los Angeles, CA": "31080"})

    def test_empty_inputs(self):
        self.assertEqual(zx.match_names([], ["Abilene, TX"]), {})
        self.assertEqual(zx.match_names([("10180", "Abilene, TX")], []), {})

    def test_micro_area_matches(self):
        mapping = zx.match_names(zx.metro_names(GAZETTEER), ["Aberdeen, SD"])
        self.assertEqual(mapping, {"Aberdeen, SD": "10100"})


class TestMonthlyRows(unittest.TestCase):
    def test_long_rows_keyed_by_code_without_gaps(self):
        long = zx.monthly_rows(frame(INVENTORY), MAPPING)
        self.assertEqual(list(long.columns), ["cbsa_code", "month", "value"])
        self.assertEqual(len(long), 7)
        self.assertNotIn("Nowhere, ZZ", long.cbsa_code.tolist())
        chicago = long[long.cbsa_code == "16980"]
        self.assertEqual(chicago.month.tolist(), ["2023-12-31", "2024-01-31", "2025-01-31"])

    def test_no_month_columns(self):
        long = zx.monthly_rows(frame("RegionID,RegionName,RegionType,Note\n1,\"Abilene, TX\",msa,x\n"), MAPPING)
        self.assertEqual(len(long), 0)
        self.assertEqual(list(long.columns), ["cbsa_code", "month", "value"])

    def test_empty_mapping_gives_no_rows(self):
        self.assertEqual(len(zx.monthly_rows(frame(INVENTORY), {})), 0)

    def test_text_cell_becomes_missing(self):
        text = HEADER + '1,1,"Abilene, TX",msa,TX,n/a,10,20,30\n'
        long = zx.monthly_rows(frame(text), MAPPING)
        self.assertEqual(long.month.tolist(), ["2024-01-31", "2024-02-29", "2025-01-31"])


class TestSummarize(unittest.TestCase):
    def summary(self, text=INVENTORY):
        df = frame(text)
        return zx.summarize(zx.monthly_rows(df, MAPPING), "inventory", zx.month_columns(df))

    def test_columns_and_metric(self):
        df = self.summary()
        self.assertEqual(list(df.columns), zx.COLUMNS)
        self.assertEqual(set(df.metric), {"inventory"})

    def test_annual_means_and_newest_month(self):
        self.assertEqual(rows(self.summary(), "10180"), {"2023": 50.0, "2024": 15.0, "2025": 30.0, "2025-01": 30.0})

    # the missing february leaves chicago one of the two months zillow
    # published for 2024, too little of the year to have a mean
    def test_missing_month_leaves_the_year_short(self):
        self.assertEqual(rows(self.summary(), "16980"), {"2023": 500.0, "2025": 300.0, "2025-01": 300.0})

    def test_unmatched_zillow_name_emits_nothing(self):
        self.assertEqual(set(self.summary().cbsa_code), {"10180", "16980"})

    def test_year_with_no_data_has_no_row(self):
        periods = set(self.summary().period)
        self.assertNotIn("2019", periods)
        self.assertNotIn("2022", periods)

    def test_newest_month_skips_a_trailing_gap(self):
        text = HEADER + '1,1,"Abilene, TX",msa,TX,50,10,20,\n'
        self.assertEqual(rows(self.summary(text), "10180"), {"2023": 50.0, "2024": 15.0, "2024-02": 20.0})

    def test_all_missing_row_emits_nothing(self):
        text = HEADER + '1,1,"Abilene, TX",msa,TX,,,,\n'
        self.assertEqual(len(self.summary(text)), 0)

    def test_empty_frame(self):
        df = self.summary(HEADER)
        self.assertEqual(len(df), 0)
        self.assertEqual(list(df.columns), zx.COLUMNS)

    def test_empty_long_frame(self):
        df = zx.summarize(pd.DataFrame(columns=["cbsa_code", "month", "value"]), "inventory", [])
        self.assertEqual(len(df), 0)
        self.assertEqual(list(df.columns), zx.COLUMNS)

    def test_values_rounded_to_four_places(self):
        text = HEADER + '1,1,"Abilene, TX",msa,TX,1,2,2,\n'
        self.assertEqual(rows(self.summary(text), "10180")["2024"], 2.0)
        text = HEADER + '1,1,"Abilene, TX",msa,TX,,1,2,\n'
        self.assertEqual(rows(self.summary(text), "10180")["2024"], 1.5)
        text = HEADER + '1,1,"Abilene, TX",msa,TX,,0.123456,0.2,\n'
        self.assertEqual(rows(self.summary(text), "10180")["2024"], round((0.123456 + 0.2) / 2, 4))

    def test_periods_have_the_map_shapes(self):
        for period in self.summary().period:
            self.assertRegex(period, r"^\d{4}(-\d{2})?$")

    def test_one_newest_row_per_code(self):
        df = self.summary()
        monthly = df[df.period.str.len() == 7]
        self.assertEqual(monthly.cbsa_code.tolist(), ["10180", "16980"])


class TestForecastRows(unittest.TestCase):
    def test_one_year_column_dated_by_base_month(self):
        df = zx.forecast_rows(frame(FORECAST), MAPPING)
        self.assertEqual(list(df.columns), zx.COLUMNS)
        self.assertEqual(rows(df, "10180"), {"2026-07": 2.3})
        self.assertEqual(set(df.metric), {"zhvf_forecast"})

    def test_missing_forecast_value_emits_nothing(self):
        df = zx.forecast_rows(frame(FORECAST), MAPPING)
        self.assertNotIn("16980", df.cbsa_code.tolist())
        self.assertEqual(len(df), 1)

    def test_unmatched_name_emits_nothing(self):
        df = zx.forecast_rows(frame(FORECAST), {})
        self.assertEqual(len(df), 0)

    def test_no_one_year_column(self):
        text = FORECAST.replace("2027-07-31", "2027-06-30")
        self.assertEqual(len(zx.forecast_rows(frame(text), MAPPING)), 0)

    def test_base_date_varies_per_row(self):
        text = (
            "RegionID,SizeRank,RegionName,RegionType,StateName,BaseDate,2026-08-31,2027-06-30,2027-07-31\n"
            '1,1,"Abilene, TX",msa,TX,2026-06-30,0.6,2.1,2.3\n'
            '2,2,"Chicago, IL",msa,IL,2026-07-31,0.1,0.4,1.7\n'
        )
        df = zx.forecast_rows(frame(text), MAPPING)
        self.assertEqual(rows(df, "10180"), {"2026-06": 2.1})
        self.assertEqual(rows(df, "16980"), {"2026-07": 1.7})

    def test_bad_base_date_skipped(self):
        text = FORECAST.replace('"Abilene, TX",msa,TX,2026-07-31', '"Abilene, TX",msa,TX,soon')
        self.assertEqual(len(zx.forecast_rows(frame(text), MAPPING)), 0)

    def test_no_base_date_column(self):
        df = zx.forecast_rows(frame(INVENTORY), MAPPING)
        self.assertEqual(len(df), 0)
        self.assertEqual(list(df.columns), zx.COLUMNS)

    def test_empty_frame(self):
        self.assertEqual(len(zx.forecast_rows(frame(FORECAST.split("\n", 1)[0] + "\n"), MAPPING)), 0)


class TestContract(unittest.TestCase):
    def test_metric_names_are_not_reserved(self):
        self.assertEqual(set(zx.FILES) & build_map_data.RESERVED, set())
        for metric in zx.FILES:
            self.assertRegex(metric, r"^[a-z][a-z0-9_]*$")

    def test_looks_like_csv(self):
        self.assertTrue(zx.looks_like_csv(b"RegionID,RegionName\r\n1,x\r\n"))
        self.assertFalse(zx.looks_like_csv(b"<html><body>RegionName</body></html>"))
        self.assertFalse(zx.looks_like_csv(b""))


# collect() runs offline against canned responses in a temp folder
class TestCollect(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.centroids = self.root / "cbsa_centroids.csv"
        GAZETTEER.to_csv(self.centroids, index=False)
        self.out_dir = self.root / "zillow_extras"
        self.bodies = {
            zx.FILES["inventory"][0]: INVENTORY.encode(),
            zx.FILES["days_to_pending"][0]: INVENTORY.replace("50,10,20,30", "70,60,80,90").encode(),
            zx.FILES["price_cut_share"][0]: INVENTORY.encode(),
            zx.FILES["zhvf_forecast"][0]: FORECAST.encode(),
        }

    def tearDown(self):
        self.tmp.cleanup()

    def fake_fetch(self, url, **kwargs):
        body = self.bodies.get(url)
        if body is None:
            return Mock(status_code=404, content=b"not found")
        return Mock(status_code=200, content=body)

    def run_collect(self):
        with patch.object(zx, "fetch", side_effect=self.fake_fetch), \
                patch.object(zx, "CENTROIDS", self.centroids), \
                patch.object(zx, "OUT_DIR", self.out_dir), \
                patch.object(zx, "OUT_FILE", self.out_dir / "metrics.csv"):
            return zx.collect()

    def test_writes_metrics_with_the_map_columns(self):
        path = self.run_collect()
        self.assertEqual(path, self.out_dir / "metrics.csv")
        df = pd.read_csv(path, dtype={"cbsa_code": str, "period": str})
        self.assertEqual(list(df.columns), zx.COLUMNS)
        self.assertEqual(set(df.metric), {"inventory", "days_to_pending", "price_cut_share", "zhvf_forecast"})
        self.assertEqual(rows(df, "10180", "days_to_pending"), {"2023": 70.0, "2024": 70.0, "2025": 90.0, "2025-01": 90.0})
        self.assertEqual(rows(df, "10180", "zhvf_forecast"), {"2026-07": 2.3})
        self.assertFalse(df.value.isna().any())
        self.assertNotIn("Nowhere, ZZ", path.read_text())

    def test_raw_csvs_are_not_kept(self):
        self.run_collect()
        self.assertEqual(sorted(p.name for p in self.out_dir.iterdir()), ["download_manifest.json", "metrics.csv"])

    def test_manifest_describes_metrics_and_each_raw_file(self):
        self.run_collect()
        entries = json.loads((self.out_dir / "download_manifest.json").read_text())
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["filename"], "metrics.csv")
        self.assertEqual(entry["source"]["provider"], "Zillow Research")
        self.assertEqual(entry["source"]["endpoint"], zx.CATALOG)
        self.assertEqual(entry["version"], "through 2025-01-31")
        # chicago is short of three quarters of the months 2024 published
        self.assertEqual(entry["integrity"]["row_count"], (4 + 3) * 3 + 1)
        notes = entry["notes"]
        self.assertEqual(notes["attribution"], zx.ATTRIBUTION)
        self.assertEqual(set(notes["files"]), set(zx.FILES))
        inventory = notes["files"]["inventory"]
        self.assertEqual(inventory["sha256"], hashlib.sha256(INVENTORY.encode()).hexdigest())
        self.assertEqual(inventory["size_kb"], round(len(INVENTORY.encode()) / 1024, 1))
        self.assertEqual(inventory["newest_column"], "2025-01-31")
        self.assertEqual(inventory["rows"], 3)
        self.assertEqual(inventory["url"], zx.FILES["inventory"][0])
        self.assertEqual(notes["files"]["zhvf_forecast"]["newest_column"], "2027-07-31")
        self.assertEqual(notes["files"]["zhvf_forecast"]["base_date"], "2026-07-31")
        self.assertEqual(notes["skipped"], [])
        self.assertEqual(notes["zillow_metros"], 3)
        self.assertEqual(notes["zillow_metros_unmatched"], 1)
        self.assertEqual(notes["gazetteer_metros_matched"], 2)
        self.assertEqual(notes["gazetteer_metros"], 3)

    def test_a_missing_file_is_skipped_and_reported(self):
        del self.bodies[zx.FILES["days_to_pending"][0]]
        path = self.run_collect()
        df = pd.read_csv(path, dtype={"cbsa_code": str})
        self.assertNotIn("days_to_pending", set(df.metric))
        notes = json.loads((self.out_dir / "download_manifest.json").read_text())[0]["notes"]
        self.assertEqual(notes["skipped"], ["days_to_pending"])
        self.assertNotIn("days_to_pending", notes["files"])

    def test_html_body_is_skipped(self):
        self.bodies[zx.FILES["inventory"][0]] = b"<html>RegionName</html>"
        path = self.run_collect()
        self.assertNotIn("inventory", set(pd.read_csv(path).metric))

    def test_nothing_fetched_raises(self):
        self.bodies.clear()
        with self.assertRaises(RuntimeError):
            self.run_collect()
        self.assertFalse((self.out_dir / "metrics.csv").exists())

    def test_builder_loads_the_output(self):
        path = self.run_collect()
        loaded = build_map_data.load_enrichment(path)
        self.assertEqual(loaded["name"], "zillow_extras")
        self.assertEqual(loaded["metrics"], ["days_to_pending", "inventory", "price_cut_share", "zhvf_forecast"])
        annual, latest = build_map_data.enrich_values(loaded["groups"]["10180"])
        self.assertEqual(annual[("inventory", 2024)], 15.0)
        self.assertEqual(latest["inventory"], ("2025-01", 30.0))
        self.assertEqual(latest["zhvf_forecast"], ("2026-07", 2.3))


if __name__ == "__main__":
    unittest.main()

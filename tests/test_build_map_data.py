import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pandas as pd

from bot import build_map_data as bm
from bot import indicators

MERGED_COLS = [
    "place_id", "place_name", "hpi_type", "hpi_flavor", "yr", "avg_index_nsa",
    "quarters_available", "NAME", "median_income", "total_pop", "median_age",
    "adults_25_plus", "bachelors_count", "masters_count", "total_occupied_units",
    "owner_occupied_units", "median_home_value", "cbsa_code", "year", "homeownership_rate",
]


def merged_row(cbsa, name, year, hpi, income, pop, age, adults, bach, mast, occ, own, hv, rate):
    return [cbsa, name, "traditional", "all-transactions", year, hpi, 4, f"{name} Metro Area",
            income, pop, age, adults, bach, mast, occ, own, hv, cbsa, year, rate]


# abilene is the clean base case. chicago is missing 2014, has zero income in
# 2019, a census sentinel in 2024 and needs the first-city zillow fallback.
# springfield has no zillow row. nowhere has no centroid
MERGED = [
    merged_row("10180", "Abilene, TX", 2014, 100.0, 40000, 100000, 30.0, 65000, 10000, 2000, 50000, 30000, 80000, 0.6),
    merged_row("10180", "Abilene, TX", 2019, 125.0, 50000, 110000, 31.5, 70000, 12000, 3000, 52000, 31200, 110000, 0.6),
    merged_row("10180", "Abilene, TX", 2024, 150.0, 60000, 120000, 33.0, 78000, 15000, 3000, 55000, 34100, 150000, 0.62),
    merged_row("16980", "Chicago-Naperville-Elgin, IL-IN-WI", 2019, 140.0, 0, 9500000, 36.0, 6300000, 1500000, 700000, 3500000, 2200000, 250000, ""),
    merged_row("16980", "Chicago-Naperville-Elgin, IL-IN-WI", 2024, 170.0, 80000, 9400000, -666666666, 6400000, 1600000, 800000, 3600000, 2300000, 320000, 0.64),
    merged_row("44100", "Springfield, IL", 2014, 90.0, 50000, 200000, 38.0, 130000, 20000, 8000, 90000, 60000, 120000, 0.67),
    merged_row("44100", "Springfield, IL", 2019, 100.0, 55000, 205000, 39.0, 133000, 22000, 9000, 91000, 61000, 130000, 0.67),
    merged_row("44100", "Springfield, IL", 2024, 120.0, 60000, 208000, 40.0, 135000, 24000, 10000, 92000, 62000, 150000, 0.67),
    merged_row("99999", "Nowhere, ZZ", 2014, 100.0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5),
]

CENTROIDS = pd.DataFrame({
    "cbsa_code": ["10180", "16980", "44100"],
    "name": ["Abilene, TX Metro Area", "Chicago-Naperville-Elgin, IL-IN-WI Metro Area", "Springfield, IL Metro Area"],
    "cbsa_type": [1, 1, 1],
    "land_sqmi": [2743.5, 7197.0, 868.0],
    "lat": [32.452022, 41.8, 39.8],
    "lon": [-99.718743, -87.9, -89.6],
})

ZILLOW_META = ["RegionID", "SizeRank", "RegionName", "RegionType", "StateName"]

ZHVI = pd.DataFrame(
    [[102001, 0, "United States", "country", None, 1, 1, 1, 1, 1, 1],
     [394297, 1, "Chicago, IL", "msa", "IL", 200000, 202000, 240000, 300000, None, 310000],
     [394299, 2, "Abilene, TX", "msa", "TX", 90000, 92000, 120000, 160000, None, 170000]],
    columns=ZILLOW_META + ["2014-01-31", "2014-02-28", "2019-01-31", "2024-01-31", "2024-02-29", "2026-07-31"],
)

ZORI = pd.DataFrame(
    [[102001, 0, "United States", "country", None, 1, 1, 1, 1],
     [394299, 2, "Abilene, TX", "msa", "TX", 1000, 1100, 1300, 1400]],
    columns=ZILLOW_META + ["2019-01-31", "2019-02-28", "2024-01-31", "2026-07-31"],
)

BLS = pd.DataFrame({
    "series_id": ["LAUMT481018000000003"] * 4,
    "cbsa_code": ["10180"] * 4,
    "year": [2019, 2024, 2025, 2025],
    "period": ["M13", "M13", "M03", "M02"],
    "value": [3.5, 3.4, 3.7, 3.9],
})

FORECAST_ROWS = [
    "10180,hpi_forecast_4q,2026-06,3.1", "10180,hpi_forecast_4q_lo,2026-06,-1.2", "10180,hpi_forecast_4q_hi,2026-06,7.0",
    "10180,hpi_forecast_8q,2026-06,6.0", "10180,hpi_forecast_8q_lo,2026-06,-2.5", "10180,hpi_forecast_8q_hi,2026-06,14.2",
    "10180,hpi_yoy_latest,2026-06,2.0", "10180,hpi_trend_5y,2026-06,5.4", "10180,hpi_surprise_4q,2026-06,-1.1",
]

# two months of every series the contract asks for: a rate that looks like a
# rate, and an index that rose three percent
NATIONAL_LEVELS = {
    "DGS1": (4.20, 3.60), "DGS10": (4.08, 4.48), "EFFR": (4.33, 4.08),
    "DFEDTARU": (4.50, 4.25), "MORTGAGE30US": (6.58, 6.35),
    "UMCSENT": (67.9, 55.1), "MICH": (3.2, 4.6), "UNRATE": (4.3, 3.9),
}


def national_rows():
    lines = ["series_id,date,value"]
    for series in indicators.series_ids():
        older, newer = NATIONAL_LEVELS.get(series, (100.0, 103.0))
        lines += [f"{series},2025-08-01,{older}", f"{series},2026-08-01,{newer}"]
    return "\n".join(lines) + "\n"


FRED = pd.DataFrame({
    "date": ["2014-01-02", "2014-01-09", "2019-01-03", "2024-01-04", "2024-01-11", "2026-09-10", "2026-09-17"],
    "value": [4.5, 4.3, 4.0, 6.6, 6.8, 6.76, None],
})


def write_fixtures(folder):
    folder = Path(folder)
    paths = {
        # keep the build away from the real data/raw enrichment files and
        # from a real forecast export under ml/results
        "enrichment_dir": folder,
        "forecast_dir": folder / "forecast",
        "merged": folder / "merged.csv",
        "centroids": folder / "centroids.csv",
        "zhvi": folder / "zhvi.csv",
        "zori": folder / "zori.csv",
        "bls": folder / "bls.csv",
        "fred": folder / "fred.csv",
        # absent unless a test writes it, like fhfa below
        "national": folder / "indicators.csv",
        # absent unless a test writes it, so the real master file stays out
        "fhfa": folder / "hpi_master.csv",
    }
    pd.DataFrame(MERGED, columns=MERGED_COLS).to_csv(paths["merged"], index=False)
    CENTROIDS.to_csv(paths["centroids"], index=False)
    ZHVI.to_csv(paths["zhvi"], index=False)
    ZORI.to_csv(paths["zori"], index=False)
    BLS.to_csv(paths["bls"], index=False)
    FRED.to_csv(paths["fred"], index=False)
    return paths


class BuildCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.paths = write_fixtures(self.tmp.name)

    def build(self, **overrides):
        paths = dict(self.paths)
        paths.update(overrides)
        out = bm.build(out_path=Path(self.tmp.name) / "metros.json", paths=paths)
        return json.loads(out.read_text())

    def metro(self, payload, cbsa):
        return next(m for m in payload["metros"] if m["cbsa"] == cbsa)

    def build_to(self, out):
        return json.loads(bm.build(out_path=out, paths=dict(self.paths)).read_text())


class TestBaseCases(BuildCase):
    def test_growth_ptir_and_degree_share_exact(self):
        abilene = self.metro(self.build(), "10180")
        self.assertEqual(abilene["growth"], {
            "hpi_14_19": 0.25, "hpi_19_24": 0.2, "income_14_24": 0.5,
            "pop_14_24": 0.2, "home_value_14_24": 0.875,
        })
        self.assertEqual(abilene["ptir"], {"2014": 2.0, "2019": 2.2, "2024": 2.5})
        # b15003 counts adults 25 and over, so the share is over that universe
        # and not over everyone. abilene 2014 is 12,000 of 65,000, not of 100,000
        self.assertEqual([abilene["years"][y]["degree_share"] for y in ("2014", "2019", "2024")], [0.1846, 0.2143, 0.2308])
        self.assertEqual(abilene["years"]["2024"]["own_rate"], 0.62)
        self.assertEqual(abilene["years"]["2014"]["pop"], 100000)
        self.assertEqual(abilene["lat"], 32.452022)

    # a suppressed universe leaves the share unknown. falling back on total
    # population would publish a number a third too low and call it the same
    def test_degree_share_is_null_without_its_universe(self):
        rows = [list(row) for row in MERGED]
        for row in rows:
            if row[0] == "10180" and row[4] == 2019:
                row[MERGED_COLS.index("adults_25_plus")] = ""
        frame = pd.DataFrame(rows, columns=MERGED_COLS)
        path = Path(self.tmp.name) / "merged_no_universe.csv"
        frame.to_csv(path, index=False)
        abilene = self.metro(self.build(merged=path), "10180")
        self.assertIsNone(abilene["years"]["2019"]["degree_share"])
        self.assertEqual(abilene["years"]["2014"]["degree_share"], 0.1846)

    def test_zillow_exact_match_and_annual_mean(self):
        abilene = self.metro(self.build(), "10180")
        self.assertEqual(abilene["years"]["2014"]["zhvi"], 91000.0)
        self.assertEqual(abilene["years"]["2019"]["zhvi"], 120000.0)
        # the null february month is skipped, not averaged as zero
        self.assertEqual(abilene["years"]["2024"]["zhvi"], 160000.0)
        self.assertEqual(abilene["latest"]["zhvi"], 170000.0)
        self.assertEqual(abilene["latest"]["zhvi_date"], "2026-07-31")
        # zori starts in 2015 so 2014 is null
        self.assertIsNone(abilene["years"]["2014"]["zori"])
        self.assertEqual(abilene["years"]["2019"]["zori"], 1050.0)

    def test_zillow_first_city_fallback(self):
        chicago = self.metro(self.build(), "16980")
        self.assertEqual(chicago["years"]["2014"]["zhvi"], 201000.0)
        self.assertEqual(chicago["latest"]["zhvi"], 310000.0)

    def test_bls_annual_versus_newest_month(self):
        abilene = self.metro(self.build(), "10180")
        self.assertIsNone(abilene["years"]["2014"]["unemp"])
        self.assertEqual(abilene["years"]["2019"]["unemp"], 3.5)
        self.assertEqual(abilene["years"]["2024"]["unemp"], 3.4)
        self.assertEqual(abilene["latest"]["unemp"], 3.7)
        self.assertEqual(abilene["latest"]["unemp_date"], "2025-03")

    def test_fred_annual_mean_and_latest(self):
        payload = self.build()
        self.assertEqual(payload["national"]["mortgage_rate"], {
            "2014": 4.4, "2019": 4.0, "2024": 6.7, "latest": 6.76, "latest_date": "2026-09-10",
        })
        self.assertEqual(payload["sources"], {
            "gazetteer": "2024 Gazetteer", "zillow": "through 2026-07-31",
            "bls": "2019 onward", "fred": "through 2026-09-10",
        })

    # the model's export is found at the fixture's second root, lands in latest
    # under its origin month and names its version in the sources block
    def test_forecast_export_lands_in_latest_with_its_manifest_version(self):
        folder = Path(self.paths["forecast_dir"])
        folder.mkdir()
        (folder / "metrics.csv").write_text("cbsa_code,metric,period,value\n" + "\n".join(FORECAST_ROWS) + "\n")
        (folder / "download_manifest.json").write_text(json.dumps([{"version": "gru, origin 2026Q2"}]))
        payload = self.build()
        self.assertEqual(payload["sources"]["forecast"], "gru, origin 2026Q2")
        self.assertEqual(payload["sources"]["fred"], "through 2026-09-10")
        abilene = self.metro(payload, "10180")
        self.assertEqual((abilene["latest"]["hpi_forecast_4q"], abilene["latest"]["hpi_forecast_4q_date"]), (3.1, "2026-06"))
        self.assertEqual((abilene["latest"]["hpi_forecast_8q_hi"], abilene["latest"]["hpi_surprise_4q"]), (14.2, -1.1))
        self.assertIsNone(abilene["years"]["2024"]["hpi_forecast_4q"])
        # a metro without forecast rows carries the keys with nulls
        chicago = self.metro(payload, "16980")
        self.assertIsNone(chicago["latest"]["hpi_forecast_4q"])
        self.assertIsNone(chicago["latest"]["hpi_forecast_4q_date"])


class TestEdgeCases(BuildCase):
    def test_missing_optional_files_still_build(self):
        gone = Path(self.tmp.name) / "gone.csv"
        payload = self.build(zhvi=gone, zori=gone, bls=gone, fred=gone)
        abilene = self.metro(payload, "10180")
        self.assertIsNone(payload["national"])
        self.assertEqual(payload["sources"]["zillow"], None)
        self.assertEqual(payload["sources"]["bls"], None)
        self.assertEqual(payload["sources"]["fred"], None)
        self.assertIsNone(abilene["years"]["2019"]["zhvi"])
        self.assertIsNone(abilene["years"]["2019"]["unemp"])
        # no fhfa master in this build, so the headline index has no latest either
        self.assertEqual(abilene["latest"], {"zhvi": None, "zhvi_date": None, "zori": None,
                                             "zori_date": None, "unemp": None, "unemp_date": None,
                                             "hpi": None, "hpi_date": None})
        # the required inputs still produce the census side
        self.assertEqual(abilene["ptir"]["2024"], 2.5)

    def test_metro_missing_a_year_gives_null_growth_for_that_pair(self):
        chicago = self.metro(self.build(), "16980")
        self.assertIsNone(chicago["growth"]["hpi_14_19"])
        self.assertIsNone(chicago["growth"]["income_14_24"])
        self.assertEqual(chicago["growth"]["hpi_19_24"], 0.2143)
        # the missing year is present with nulls, not absent
        self.assertIsNone(chicago["years"]["2014"]["hpi"])
        self.assertIn("2014", chicago["ptir"])

    def test_zero_income_gives_null_ptir(self):
        chicago = self.metro(self.build(), "16980")
        self.assertIsNone(chicago["ptir"]["2019"])
        self.assertEqual(chicago["ptir"]["2024"], 4.0)

    def test_census_sentinel_becomes_null(self):
        chicago = self.metro(self.build(), "16980")
        self.assertIsNone(chicago["years"]["2024"]["age"])
        self.assertEqual(chicago["years"]["2019"]["age"], 36.0)

    def test_blank_ownership_rate_falls_back_to_the_counts(self):
        chicago = self.metro(self.build(), "16980")
        self.assertEqual(chicago["years"]["2019"]["own_rate"], 0.6286)

    def test_all_null_zillow_months(self):
        row = pd.Series([None, None], index=["2024-01-31", "2024-02-29"], dtype="float64")
        self.assertIsNone(bm.zillow_annual(row, 2024))
        self.assertEqual(bm.zillow_latest(row), (None, None))

    def test_metro_without_centroid_is_dropped(self):
        payload = self.build()
        self.assertEqual([m["cbsa"] for m in payload["metros"]], ["10180", "16980", "44100"])

    def test_unmatched_zillow_name_gives_nulls(self):
        springfield = self.metro(self.build(), "44100")
        self.assertIsNone(springfield["years"]["2024"]["zhvi"])
        self.assertIsNone(springfield["latest"]["zhvi"])
        self.assertEqual(springfield["ptir"]["2024"], 2.5)

    def test_output_shape_and_sort_order(self):
        payload = self.build()
        self.assertEqual(list(payload), ["generated_at", "years", "sources", "provenance", "national", "metros"])
        self.assertEqual(payload["years"], [2014, 2019, 2024])
        names = [m["name"] for m in payload["metros"]]
        self.assertEqual(names, sorted(names))
        metro = payload["metros"][0]
        self.assertEqual(list(metro), ["cbsa", "name", "level", "parent", "zillow_scope", "lat", "lon", "years", "latest", "growth", "ptir", "parent_metrics"])
        self.assertEqual(list(metro["years"]), ["2014", "2019", "2024"])
        self.assertEqual(list(metro["years"]["2014"]), ["hpi", "income", "pop", "age", "degree_share",
                                                        "own_rate", "home_value", "zhvi", "zori", "unemp"])
        self.assertEqual(list(metro["latest"]), ["zhvi", "zhvi_date", "zori", "zori_date", "unemp", "unemp_date",
                                                 "hpi", "hpi_date"])
        self.assertEqual(list(metro["growth"]), ["hpi_14_19", "hpi_19_24", "income_14_24", "pop_14_24", "home_value_14_24"])
        self.assertEqual(list(metro["ptir"]), ["2014", "2019", "2024"])
        # the file is plain ascii json with no nan tokens
        text = (Path(self.tmp.name) / "metros.json").read_text()
        self.assertTrue(text.isascii())
        self.assertNotIn("NaN", text)


class TestHelpers(unittest.TestCase):
    def test_zillow_candidates_order_and_dedupe(self):
        self.assertEqual(bm.zillow_candidates("Chicago-Naperville-Elgin, IL-IN-WI"),
                         ["Chicago-Naperville-Elgin, IL-IN-WI", "Chicago, IL",
                          "Chicago-Naperville, IL", "Naperville, IL", "Elgin, IL"])
        self.assertEqual(bm.zillow_candidates("Abilene, TX"), ["Abilene, TX"])
        self.assertEqual(bm.zillow_candidates("Winston-Salem, NC"),
                         ["Winston-Salem, NC", "Winston, NC", "Salem, NC"])

    # a slash separates city and county; zillow keeps only the city
    def test_zillow_candidates_slash_county(self):
        self.assertIn("Louisville, KY", bm.zillow_candidates("Louisville/Jefferson County, KY-IN"))

    # zillow can name the metro by a later city, tried after the first
    def test_zillow_candidates_later_city(self):
        cands = bm.zillow_candidates("Wildwood-The Villages, FL")
        self.assertIn("The Villages, FL", cands)
        self.assertLess(cands.index("Wildwood, FL"), cands.index("The Villages, FL"))

    def test_growth_and_ratio_guards(self):
        self.assertIsNone(bm.growth(10, 0))
        self.assertIsNone(bm.growth(None, 5))
        self.assertIsNone(bm.growth(float("nan"), 5))
        self.assertEqual(bm.growth(15, 10), 0.5)
        self.assertIsNone(bm.ratio(5, 0))
        self.assertEqual(bm.ratio(5, 2), 2.5)

    def test_bls_latest_orders_by_year_then_period(self):
        frame = pd.DataFrame({
            "series_id": ["x"] * 3, "cbsa_code": ["10180"] * 3,
            "year": [2025, 2024, 2025], "period": ["M02", "M12", "M03"], "value": [3.9, 3.1, 3.7],
        })
        self.assertEqual(bm.bls_latest(frame, "10180"), (3.7, "2025-03"))
        self.assertEqual(bm.bls_latest(frame, "00000"), (None, None))

    def test_fred_latest_skips_trailing_null(self):
        frame = pd.DataFrame({"date": ["2026-09-10", "2026-09-17"], "value": [6.76, None]})
        self.assertEqual(bm.fred_latest(frame), (6.76, "2026-09-10"))
        self.assertEqual(bm.fred_annual(frame, 2026), 6.76)
        self.assertIsNone(bm.fred_annual(frame, 2014))

    def test_rounding_helpers(self):
        self.assertIsNone(bm.rnd(None, 2))
        self.assertIsNone(bm.rnd(float("nan"), 2))
        self.assertEqual(bm.rnd(1.23456, 2), 1.23)
        self.assertEqual(bm.as_int(167171.0), 167171)


# a folder's version line, which the site prints as its vintage
class TestFolderVersion(unittest.TestCase):
    def test_a_rollup_entry_speaks_for_the_folder(self):
        entries = [
            {"filename": "metrics.csv", "version": "ACS 5-year 2014, 2019, 2024"},
            {"filename": "acs_extra_2014.csv", "version": "ACS 5-year 2014"},
            {"filename": "acs_extra_2019.csv", "version": "ACS 5-year 2019"},
        ]
        self.assertEqual(bm.folder_version(entries), "ACS 5-year 2014, 2019, 2024")

    # census holds three peer vintages and no rollup, so taking the first named
    # one of the three and the site's vintage line said 2014
    def test_peer_files_are_all_named(self):
        entries = [
            {"filename": "acs_5yr_2014.csv", "version": "ACS 5-year 2014"},
            {"filename": "acs_5yr_2019.csv", "version": "ACS 5-year 2019"},
            {"filename": "acs_5yr_2024.csv", "version": "ACS 5-year 2024"},
        ]
        self.assertEqual(bm.folder_version(entries),
                         "ACS 5-year 2014, ACS 5-year 2019, ACS 5-year 2024")

    def test_one_version_across_several_files_is_not_repeated(self):
        entries = [{"filename": "a.csv", "version": "2026-Q2"}, {"filename": "b.txt", "version": "2026-Q2"}]
        self.assertEqual(bm.folder_version(entries), "2026-Q2")

    def test_a_manifest_with_no_version_says_present(self):
        self.assertEqual(bm.folder_version([{"filename": "a.csv"}]), "present")
        self.assertEqual(bm.folder_version([]), "present")


if __name__ == "__main__":
    unittest.main()


class TestDivisions(unittest.TestCase):
    def frames(self):
        merged = pd.DataFrame({
            "cbsa_code": ["16984", "16984", "10180"],
            "place_name": ["Chicago-Naperville-Schaumburg, IL (MSAD)"] * 2 + ["Abilene, TX"],
            "year": [2019, 2024, 2024],
            "avg_index_nsa": [200.0, 260.0, 335.5],
            "median_income": [80000, 90000, 50000],
            "total_pop": [7000000, 7100000, 170000],
            "median_home_value": [300000, 340000, 130000],
            "geo_level": ["division", "division", "msa"],
            "parent_cbsa": ["16980", "16980", None],
        })
        centroids = pd.DataFrame({
            "cbsa_code": ["16980", "16984", "10180"],
            "name": ["Chicago-Naperville-Elgin, IL-IN Metro Area", "Chicago-Naperville-Schaumburg, IL Metro Division", "Abilene, TX Metro Area"],
            "lat": [41.8, 41.85, 32.45], "lon": [-87.9, -87.95, -99.7],
        }).set_index("cbsa_code")
        zhvi = pd.DataFrame({"2024-06-30": [400000.0, 210000.0]}, index=pd.Index(["Chicago, IL", "Abilene, TX"], name="RegionName"))
        return merged, centroids, zhvi

    def test_division_carries_level_parent_and_clean_name(self):
        merged, centroids, zhvi = self.frames()
        metros, _, _ = bm.build_metros(merged, centroids, zhvi=zhvi)
        chi = next(m for m in metros if m["cbsa"] == "16984")
        self.assertEqual(chi["name"], "Chicago-Naperville-Schaumburg, IL")
        self.assertEqual(chi["level"], "division")
        self.assertEqual(chi["parent"], {"cbsa": "16980", "name": "Chicago-Naperville-Elgin, IL-IN"})

    # zillow has no divisions, so the parent metro's value is used and labeled
    def test_division_takes_zillow_from_parent(self):
        merged, centroids, zhvi = self.frames()
        metros, _, unmatched = bm.build_metros(merged, centroids, zhvi=zhvi)
        chi = next(m for m in metros if m["cbsa"] == "16984")
        self.assertEqual(chi["latest"]["zhvi"], 400000.0)
        self.assertEqual(chi["zillow_scope"], "parent metro")
        self.assertEqual(unmatched, 0)

    def test_msa_is_unchanged(self):
        merged, centroids, zhvi = self.frames()
        metros, _, _ = bm.build_metros(merged, centroids, zhvi=zhvi)
        abi = next(m for m in metros if m["cbsa"] == "10180")
        self.assertEqual((abi["level"], abi["parent"], abi["zillow_scope"]), ("msa", None, "metro"))

    # a division whose parent is unknown must not fall through to a metro with
    # the same name, so it gets no zillow values at all
    def test_division_without_parent_gets_no_zillow(self):
        merged, centroids, zhvi = self.frames()
        merged.loc[merged.cbsa_code == "16984", "parent_cbsa"] = "00000"
        metros, _, _ = bm.build_metros(merged, centroids, zhvi=zhvi)
        chi = next(m for m in metros if m["cbsa"] == "16984")
        self.assertIsNone(chi["parent"])
        self.assertIsNone(chi["latest"]["zhvi"])
        self.assertIsNone(chi["zillow_scope"])

    # rent can be inherited on its own when zillow's value file misses the
    # parent metro but its rent file carries it. the inheritance still has to
    # be disclosed, or the reader takes the parent's rent for the division's
    def test_division_discloses_parent_scope_when_only_rent_is_inherited(self):
        merged, centroids, zhvi = self.frames()
        zhvi = zhvi.drop(index="Chicago, IL")
        zori = pd.DataFrame({"2024-06-30": [2252.6]}, index=pd.Index(["Chicago, IL"], name="RegionName"))
        metros, _, _ = bm.build_metros(merged, centroids, zhvi=zhvi, zori=zori)
        chi = next(m for m in metros if m["cbsa"] == "16984")
        self.assertIsNone(chi["latest"]["zhvi"])
        self.assertEqual(chi["latest"]["zori"], 2252.6)
        self.assertEqual(chi["zillow_scope"], "parent metro")

    def test_display_name_strips_only_the_suffix(self):
        self.assertEqual(bm.display_name("Boston, MA (MSAD)"), "Boston, MA")
        self.assertEqual(bm.display_name("Abilene, TX"), "Abilene, TX")


class TestEnrichment(unittest.TestCase):
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

    def write(self, folder, name, rows, manifest=None):
        src = Path(folder) / name
        src.mkdir()
        (src / "metrics.csv").write_text("cbsa_code,metric,period,value\n" + "\n".join(rows) + "\n")
        if manifest is not None:
            (src / "download_manifest.json").write_text(json.dumps(manifest))
        return src

    def test_annual_and_monthly_land_in_the_right_places(self):
        merged, centroids = self.frames()
        with tempfile.TemporaryDirectory() as tmp:
            self.write(tmp, "permits", ["10180,permits,2024,850", "10180,permits,2019,600",
                                        "10180,listings,2026-07,120", "10180,listings,2024,90"])
            metros, _, _ = bm.build_metros(merged, centroids, enrichments=bm.discover_enrichments(tmp))
        abi = next(m for m in metros if m["cbsa"] == "10180")
        self.assertEqual(abi["years"]["2024"]["permits"], 850.0)
        self.assertEqual(abi["years"]["2019"]["permits"], 600.0)
        self.assertIsNone(abi["years"]["2014"]["permits"])
        # newest period wins even when a monthly and an annual row coexist
        self.assertEqual((abi["latest"]["listings"], abi["latest"]["listings_date"]), (120.0, "2026-07"))
        self.assertEqual((abi["latest"]["permits"], abi["latest"]["permits_date"]), (850.0, "2024"))

    def test_every_metro_gets_every_metric_key(self):
        merged, centroids = self.frames()
        with tempfile.TemporaryDirectory() as tmp:
            self.write(tmp, "permits", ["10180,permits,2024,850"])
            metros, _, _ = bm.build_metros(merged, centroids, enrichments=bm.discover_enrichments(tmp))
        chi = next(m for m in metros if m["cbsa"] == "16984")
        self.assertIn("permits", chi["years"]["2024"])
        self.assertIsNone(chi["years"]["2024"]["permits"])
        self.assertIsNone(chi["latest"]["permits_date"])
        self.assertEqual(chi["parent_metrics"], [])

    # a division without rows of its own takes the parent metro's value
    def test_division_inherits_from_parent_and_says_so(self):
        merged, centroids = self.frames()
        with tempfile.TemporaryDirectory() as tmp:
            self.write(tmp, "permits", ["16980,permits,2024,30000", "16984,own_metric,2024,1"])
            metros, _, _ = bm.build_metros(merged, centroids, enrichments=bm.discover_enrichments(tmp))
        chi = next(m for m in metros if m["cbsa"] == "16984")
        self.assertEqual(chi["years"]["2024"]["permits"], 30000.0)
        self.assertEqual(chi["years"]["2024"]["own_metric"], 1.0)
        self.assertEqual(chi["parent_metrics"], ["permits"])

    def test_metro_never_inherits(self):
        merged, centroids = self.frames()
        with tempfile.TemporaryDirectory() as tmp:
            self.write(tmp, "permits", ["16980,permits,2024,30000"])
            metros, _, _ = bm.build_metros(merged, centroids, enrichments=bm.discover_enrichments(tmp))
        abi = next(m for m in metros if m["cbsa"] == "10180")
        self.assertIsNone(abi["years"]["2024"]["permits"])
        self.assertEqual(abi["parent_metrics"], [])

    def test_reserved_metric_name_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.write(tmp, "bad", ["10180,hpi,2024,1"])
            with self.assertRaises(ValueError):
                bm.discover_enrichments(tmp)

    def test_missing_column_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "bad"
            src.mkdir()
            (src / "metrics.csv").write_text("cbsa_code,metric,value\n10180,x,1\n")
            with self.assertRaises(ValueError):
                bm.discover_enrichments(tmp)

    def test_non_numeric_rows_are_dropped_not_fatal(self):
        merged, centroids = self.frames()
        with tempfile.TemporaryDirectory() as tmp:
            self.write(tmp, "permits", ["10180,permits,2024,n/a", "10180,permits,2019,600"])
            metros, _, _ = bm.build_metros(merged, centroids, enrichments=bm.discover_enrichments(tmp))
        abi = next(m for m in metros if m["cbsa"] == "10180")
        self.assertIsNone(abi["years"]["2024"]["permits"])
        self.assertEqual(abi["years"]["2019"]["permits"], 600.0)

    def test_no_enrichment_dir_contents_is_fine(self):
        merged, centroids = self.frames()
        with tempfile.TemporaryDirectory() as tmp:
            metros, _, _ = bm.build_metros(merged, centroids, enrichments=bm.discover_enrichments(tmp))
        self.assertEqual(metros[0]["parent_metrics"], [])

    def test_sources_block_reads_the_manifest_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.write(tmp, "permits", ["10180,permits,2024,850"], manifest=[{"version": "2024 annual"}])
            self.write(tmp, "nomanifest", ["10180,other,2024,1"])
            self.assertEqual(bm.enrichment_version(Path(tmp) / "permits"), "2024 annual")
            self.assertEqual(bm.enrichment_version(Path(tmp) / "nomanifest"), "present")

    # the model's export lives under ml/results, not data/raw. its folder is a
    # root of its own, named like a collector folder, after the raw sources
    def test_forecast_folder_is_discovered_beside_the_raw_sources(self):
        merged, centroids = self.frames()
        self.assertFalse({row.split(",")[1] for row in FORECAST_ROWS} & bm.RESERVED)
        with tempfile.TemporaryDirectory() as raw, tempfile.TemporaryDirectory() as results:
            self.write(raw, "permits", ["10180,permits,2024,850"])
            forecast = self.write(results, "forecast", FORECAST_ROWS)
            enrichments = bm.discover_enrichments(raw, forecast)
            self.assertEqual([e["name"] for e in enrichments], ["permits", "forecast"])
            self.assertEqual(enrichments[1]["folder"], forecast)
            self.assertEqual(len(enrichments[1]["metrics"]), 9)
            # a root that has not been exported yet is simply absent
            self.assertEqual([e["name"] for e in bm.discover_enrichments(raw, Path(raw) / "nothing")], ["permits"])
            metros, _, _ = bm.build_metros(merged, centroids, enrichments=enrichments)
        abi = next(m for m in metros if m["cbsa"] == "10180")
        self.assertEqual((abi["latest"]["hpi_forecast_4q"], abi["latest"]["hpi_forecast_4q_date"]), (3.1, "2026-06"))
        self.assertEqual((abi["latest"]["hpi_trend_5y"], abi["latest"]["hpi_yoy_latest"]), (5.4, 2.0))
        self.assertEqual(abi["years"]["2024"]["permits"], 850.0)
        # a monthly period is latest only, never a year panel
        self.assertIsNone(abi["years"]["2024"]["hpi_forecast_4q"])


# every collector writes a download manifest beside its files. the block built
# from them is what makes the pipeline checkable from the site: the upstream
# url, the version, and the hash each file had when it landed
class TestProvenance(BuildCase):
    def manifest(self, name, entries):
        folder = Path(self.tmp.name) / name
        folder.mkdir(exist_ok=True)
        (folder / "download_manifest.json").write_text(json.dumps(entries))
        return folder

    def entry(self, **fields):
        return {
            "filename": "hpi_master.csv",
            "source": {"url": "https://www.fhfa.gov/hpi/hpi_master.csv", "provider": "FHFA"},
            "integrity": {"sha256": "f7eca3", "row_count": 186011},
            "version": "2026-Q2",
            "downloaded_at": "2026-09-14T23:12:18Z",
            **fields,
        }

    def block(self):
        return self.build()["provenance"]

    def test_a_source_carries_its_url_version_hash_and_rows(self):
        self.manifest("fhfa", [self.entry()])
        self.assertEqual(self.block(), [{
            "source": "fhfa",
            "provider": "FHFA",
            "url": "https://www.fhfa.gov/hpi/hpi_master.csv",
            "version": "2026-Q2",
            "downloaded_at": "2026-09-14T23:12:18Z",
            "files": 1,
            "row_count": 186011,
            "filename": "hpi_master.csv",
            "sha256": "f7eca3",
        }])

    # the collectors that call an api write endpoint where the ones that pull
    # a file write url, and both are where the bytes came from
    def test_an_api_collector_names_its_endpoint(self):
        self.manifest("bls", [self.entry(source={"endpoint": "https://api.bls.gov/publicAPI/v2/", "provider": "BLS"})])
        self.assertEqual(self.block()[0]["url"], "https://api.bls.gov/publicAPI/v2/")

    # bps carries thirteen files and hud five. listing every one would put the
    # folder's file list on the page instead of its provenance
    def test_several_files_are_summarised_not_listed(self):
        self.manifest("bps", [
            self.entry(filename="permits_cbsa.csv", downloaded_at="2026-09-15T19:05:09Z"),
            self.entry(filename="ma2014a.txt", integrity={"sha256": "818643", "row_count": 381},
                       downloaded_at="2026-09-15T19:05:11Z"),
        ])
        entry = self.block()[0]
        self.assertEqual((entry["files"], entry["row_count"]), (2, 186392))
        # the hash belongs to the named file, the first, which is the one the build reads
        self.assertEqual((entry["filename"], entry["sha256"]), ("permits_cbsa.csv", "f7eca3"))
        # and the folder is as old as its newest download
        self.assertEqual(entry["downloaded_at"], "2026-09-15T19:05:11Z")

    def test_one_entry_per_folder_in_folder_order(self):
        self.manifest("zillow", [self.entry()])
        self.manifest("acs", [self.entry()])
        self.assertEqual([e["source"] for e in self.block()], ["acs", "zillow"])

    # a source with no manifest still has its metrics read, it just has nothing
    # to prove with
    def test_a_folder_without_a_manifest_is_left_out(self):
        folder = Path(self.tmp.name) / "nomanifest"
        folder.mkdir()
        (folder / "metrics.csv").write_text("cbsa_code,metric,period,value\n10180,permits,2024,850\n")
        payload = self.build()
        self.assertEqual(payload["provenance"], [])
        self.assertEqual(payload["sources"]["nomanifest"], "present")
        self.assertEqual(self.metro(payload, "10180")["years"]["2024"]["permits"], 850.0)

    # a half written manifest is a bad line on a page, never a failed build
    def test_a_malformed_manifest_is_skipped_not_fatal(self):
        for text in ("{not json", "[]", "{}", '["a string"]'):
            self.manifest("broken", [])
            (Path(self.tmp.name) / "broken" / "download_manifest.json").write_text(text)
            self.manifest("fhfa", [self.entry()])
            self.assertEqual([e["source"] for e in self.block()], ["fhfa"], text)

    def test_a_manifest_that_names_no_source_is_left_out(self):
        self.manifest("forecast", [{"version": "gru, origin 2026Q2"}])
        self.assertEqual(self.block(), [])

    # a manifest missing a field carries the key as null, so the site reads one
    # shape for every source
    def test_a_field_the_manifest_lacks_is_null_not_absent(self):
        self.manifest("fred", [{"source": {"url": "https://api.stlouisfed.org/fred/series/observations"}}])
        entry = self.block()[0]
        self.assertEqual(list(entry), ["source", "provider", "url", "version", "downloaded_at",
                                       "files", "row_count", "filename", "sha256"])
        self.assertEqual([entry["provider"], entry["version"], entry["downloaded_at"],
                          entry["row_count"], entry["filename"], entry["sha256"]], [None] * 6)

    def test_a_build_with_no_sources_at_all_has_an_empty_block(self):
        self.assertEqual(self.block(), [])


# the shipped manifests, where the shapes really differ: fhfa writes source.url
# and the api collectors write source.endpoint, and a folder holds one file or
# thirteen. a block that cannot read them proves nothing on the page
class TestShippedProvenance(unittest.TestCase):
    def test_every_raw_folder_with_a_manifest_reaches_the_block(self):
        raw = Path(bm.DEFAULT_PATHS["enrichment_dir"])
        folders = sorted(p.parent.name for p in raw.glob("*/download_manifest.json"))
        block = bm.provenance_block(raw)
        self.assertEqual([e["source"] for e in block], folders)
        self.assertGreater(len(block), 10)
        for entry in block:
            self.assertTrue(entry["url"].startswith("https://"), entry["source"])
            self.assertEqual(len(entry["sha256"]), 64, entry["source"])
            self.assertGreater(entry["row_count"], 0, entry["source"])
            self.assertTrue(entry["downloaded_at"].endswith("Z"), entry["source"])


# the fhfa master file. 10180 runs four quarters a year from 2000 after one
# quarter of 1999, 19100 never holds a full year, 12580 is the deep metro fhfa
# phased in at the start, and the rest are rows the loader must drop (state
# level, purchase-only, and 1974, below the floor)
def fhfa_fixture():
    rows = []
    for year in (2000, 2001, 2002):
        for q in (1, 2, 3, 4):
            rows.append(("traditional", "all-transactions", "quarterly", "MSA", "10180", str(year), str(q), 100.0 + 10 * (year - 2000) + q))
    for year in (2000, 2002):
        rows.append(("traditional", "all-transactions", "quarterly", "MSA", "19100", str(year), "1", 200.0 + (year - 2000)))
    for year in (1974, 1975, 1976, 1978):
        for q in (1, 2, 3, 4):
            rows.append(("traditional", "all-transactions", "quarterly", "MSA", "12580", str(year), str(q), 10.0 * (year - 1973) + q))
    rows.append(("traditional", "all-transactions", "quarterly", "MSA", "12580", "1977", "2", 99.0))
    rows.append(("traditional", "all-transactions", "quarterly", "MSA", "10180", "2003", "1", 150.0))
    rows.append(("traditional", "all-transactions", "quarterly", "MSA", "10180", "2003", "2", 152.0))
    rows.append(("traditional", "purchase-only", "quarterly", "MSA", "10180", "2003", "2", 999.0))
    rows.append(("traditional", "all-transactions", "quarterly", "State", "10180", "2003", "2", 999.0))
    rows.append(("traditional", "all-transactions", "quarterly", "MSA", "10180", "1999", "4", 999.0))
    return pd.DataFrame(rows, columns=["hpi_type", "hpi_flavor", "frequency", "level", "place_id", "yr", "period", "index_nsa"])


class TestPriceHistory(BuildCase):
    def fhfa_path(self):
        path = Path(self.tmp.name) / "hpi_master.csv"
        fhfa_fixture().to_csv(path, index=False)
        return path

    # 2003 holds two quarters, 150 and 152. its mean, 151, is not an annual
    # mean and sat on a line of them, and the forecast grew from 152 while
    # appearing to start at 151
    def test_a_short_newest_year_carries_the_level_at_as_of(self):
        path = self.fhfa_path()
        abilene = self.metro(self.build(fhfa=path), "10180")
        hpi = abilene["series"]["hpi"]
        self.assertEqual(hpi["start"], 2000)
        self.assertEqual(hpi["values"], [102.5, 112.5, 122.5, 152.0])
        self.assertEqual(hpi["as_of"], "2003Q2")
        self.assertEqual(hpi["anchor"], 152.0)
        self.assertEqual(hpi["partial_year"], 2003)
        # the line now ends where the forecast starts
        self.assertEqual(hpi["values"][-1], hpi["anchor"])

    def test_a_complete_newest_year_is_still_its_mean(self):
        rows = fhfa_fixture()
        rows = rows[~((rows["place_id"] == "10180") & (rows["yr"] == "2003"))]
        path = Path(self.tmp.name) / "hpi_master.csv"
        rows.to_csv(path, index=False)
        hpi = bm.load_fhfa_series(path)["10180"]
        self.assertEqual(hpi["values"], [102.5, 112.5, 122.5])
        self.assertEqual(hpi["as_of"], "2002Q4")
        self.assertIsNone(hpi["partial_year"])

    # 1977 holds one quarter between two full years, so it has no annual mean
    # to show and the line breaks around it
    def test_a_short_year_inside_the_history_is_a_gap(self):
        series = bm.load_fhfa_series(self.fhfa_path())
        self.assertEqual(series["12580"]["values"], [22.5, 32.5, None, 52.5])
        self.assertIsNone(series["12580"]["partial_year"])

    # fhfa publishes from 1975 and the panel now draws all of it. a 2000 floor
    # threw away the two housing cycles before it, which is most of what an
    # index this old is worth reading for
    def test_the_history_reaches_back_to_1975(self):
        series = bm.load_fhfa_series(self.fhfa_path())
        self.assertEqual(bm.SERIES_START, 1975)
        self.assertEqual(series["12580"]["start"], 1975)
        self.assertEqual(series["12580"]["as_of"], "1978Q4")
        self.assertEqual(series["12580"]["anchor"], 54.0)

    # 1974 is below the floor, so its four quarters never reach the map even
    # though the master file carries them
    def test_quarters_before_the_floor_are_left_out(self):
        series = bm.load_fhfa_series(self.fhfa_path())
        self.assertEqual(series["12580"]["values"][0], 22.5)
        self.assertNotIn(11.0, series["12580"]["values"])

    # fhfa phases a metro in mid year, so its first year often has no mean.
    # a null in front of the line is empty margin on the panel, not a gap, so
    # the series starts at the first year it can draw. 10180 holds 1999Q4 alone
    def test_a_short_first_year_moves_the_start_instead_of_leading_with_a_null(self):
        series = bm.load_fhfa_series(self.fhfa_path())
        self.assertEqual(series["10180"]["start"], 2000)
        self.assertEqual(series["10180"]["values"][0], 102.5)

    # 19100 holds one quarter in 2000 and one in 2002 and no full year at all,
    # so everything before the newest quarter trims away
    def test_a_metro_with_no_full_year_is_its_newest_quarter_alone(self):
        series = bm.load_fhfa_series(self.fhfa_path())
        self.assertEqual(series["19100"]["values"], [202.0])
        self.assertEqual(series["19100"]["start"], 2002)
        self.assertEqual(series["19100"]["as_of"], "2002Q1")
        self.assertEqual(series["19100"]["partial_year"], 2002)

    # start plus the values is the year the series ends on, or the panel draws
    # the line against the wrong years
    def test_the_start_and_the_values_agree_on_the_last_year(self):
        for code, last in (("10180", 2003), ("19100", 2002), ("12580", 1978)):
            series = bm.load_fhfa_series(self.fhfa_path())[code]
            self.assertEqual(series["start"] + len(series["values"]) - 1, last, code)

    def test_no_history_file_means_no_series_key(self):
        abilene = self.metro(self.build(fhfa=Path(self.tmp.name) / "absent.csv"), "10180")
        self.assertNotIn("series", abilene)


# the daily national refresh rebuilds this file whether or not fred moved. a
# rebuild that finds nothing new must produce the same bytes, or every run
# commits 2.9 MB and republishes the site to change a timestamp
class TestRebuildIsIdempotent(BuildCase):
    # the clock is the only thing that moves between these two runs
    def build_at(self, moment, out):
        with mock.patch.object(bm, "utc_now", lambda: moment):
            return bm.build(out_path=out, paths=dict(self.paths))

    def test_two_builds_of_the_same_inputs_are_the_same_bytes(self):
        out = Path(self.tmp.name) / "metros.json"
        first = self.build_at("2026-09-15T00:00:00Z", out).read_bytes()
        second = self.build_at("2026-09-16T06:00:00Z", out).read_bytes()
        self.assertEqual(first, second)
        self.assertIn("2026-09-15T00:00:00Z", first.decode())

    def test_a_changed_input_is_written_with_a_new_stamp(self):
        out = Path(self.tmp.name) / "metros.json"
        first = json.loads(self.build_at("2026-09-15T00:00:00Z", out).read_text())
        rows = [r for r in MERGED if r[0] != "44100"]
        pd.DataFrame(rows, columns=MERGED_COLS).to_csv(self.paths["merged"], index=False)
        second = json.loads(self.build_at("2026-09-16T06:00:00Z", out).read_text())
        self.assertNotEqual(len(first["metros"]), len(second["metros"]))
        self.assertEqual(second["generated_at"], "2026-09-16T06:00:00Z")


# the zillow csvs are gitignored, so a checkout that has not run that collector
# cannot see them. a partial rebuild used to write nulls over every zhvi and
# zori in the file and call it a build. losing a source is not a rebuild
class TestARebuildCannotDropASource(BuildCase):
    def test_a_source_that_vanished_stops_the_write(self):
        out = Path(self.tmp.name) / "metros.json"
        full = self.build_to(out)
        self.assertIsNotNone(full["metros"][0]["years"]["2014"]["zhvi"])

        before = out.read_bytes()
        paths = dict(self.paths)
        paths["zhvi"] = Path(self.tmp.name) / "absent_zhvi.csv"
        with self.assertRaises(RuntimeError) as raised:
            bm.build(out_path=out, paths=paths)
        self.assertIn("zillow", str(raised.exception))
        self.assertEqual(out.read_bytes(), before)

    def test_a_first_build_with_no_zillow_is_allowed(self):
        out = Path(self.tmp.name) / "fresh.json"
        paths = dict(self.paths)
        paths["zhvi"] = Path(self.tmp.name) / "absent_zhvi.csv"
        paths["zori"] = Path(self.tmp.name) / "absent_zori.csv"
        payload = json.loads(bm.build(out_path=out, paths=paths).read_text())
        self.assertIsNone(payload["metros"][0]["years"]["2014"]["zhvi"])

    def test_a_rebuild_with_every_source_present_is_fine(self):
        out = Path(self.tmp.name) / "metros.json"
        self.build_to(out)
        again = json.loads(bm.build(out_path=out, paths=dict(self.paths)).read_text())
        self.assertIsNotNone(again["metros"][0]["years"]["2014"]["zhvi"])


class TestNationalIndicators(BuildCase):
    def test_indicators_follow_the_contract_order_and_keys(self):
        Path(self.paths["national"]).write_text(national_rows())
        block = self.build()["national"]
        self.assertEqual(block["mortgage_rate"]["latest"], 6.76)
        self.assertEqual(block["indicators_updated"], "2026-08-01")
        records = block["indicators"]
        self.assertEqual([r["id"] for r in records], [spec["id"] for spec in indicators.INDICATORS])
        self.assertEqual(list(records[0]), ["id", "label", "group", "format", "provider",
                                            "note", "value", "date", "change_12m", "history"])
        tiles = {r["id"]: r for r in records}
        self.assertEqual((tiles["cpi"]["value"], tiles["cpi"]["date"]), (3.0, "2026-08"))
        self.assertEqual(tiles["cpi"]["history"], [{"date": "2026-08", "value": 3.0}])
        self.assertEqual((tiles["unemployment"]["value"], tiles["unemployment"]["change_12m"]), (3.9, -0.4))
        # the one year treasury less the effective funds rate, same month
        self.assertEqual(tiles["rate_path"]["value"], -0.48)

    def test_missing_national_file_leaves_the_rest_intact(self):
        payload = self.build()
        self.assertEqual(list(payload["national"]), ["mortgage_rate"])
        self.assertEqual(payload["national"]["mortgage_rate"]["latest_date"], "2026-09-10")
        self.assertEqual(payload["sources"]["fred"], "through 2026-09-10")
        self.assertEqual(len(payload["metros"]), 3)
        self.assertEqual(self.metro(payload, "10180")["latest"]["zhvi"], 170000.0)


# a growth rate compares a place to itself. when omb redraws a cbsa between two
# vintages the two rows are different places wearing the same code, and the only
# honest answer is null. salisbury 41540 is the real case in the shipped merged
# file: 2014 and 2019 are the md-de footprint, 2024 is md only
# the headline hpi reads the newest fhfa quarter, not the 2024 vintage average.
# the vintages stay in the year panels; latest is the quarter the series ends on
class TestLatestHpi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        merged = bm.load_merged(bm.DEFAULT_PATHS["merged"])
        cls.rows = merged[merged["cbsa_code"] == "10180"]
        centroids = bm.load_centroids(bm.DEFAULT_PATHS["centroids"])
        series = bm.load_fhfa_series(bm.DEFAULT_PATHS["fhfa"])
        cls.metro = bm.build_metros(cls.rows, centroids, series=series)[0][0]

    def test_latest_carries_the_newest_quarter(self):
        hpi = self.metro["series"]["hpi"]
        self.assertEqual(hpi["as_of"], "2026Q2")
        self.assertEqual(self.metro["latest"]["hpi"], hpi["anchor"])

    def test_the_date_is_the_quarter_end_month(self):
        self.assertEqual(self.metro["latest"]["hpi_date"], "2026-06")

    # the shipped master file starts abilene in 1987, thirteen years before the
    # old floor let anything through, and runs to the quarter as_of names
    def test_the_shipped_series_reaches_back_past_the_old_floor(self):
        hpi = self.metro["series"]["hpi"]
        self.assertEqual(hpi["start"], 1987)
        self.assertEqual(hpi["values"][0], 98.0)
        self.assertEqual(hpi["start"] + len(hpi["values"]) - 1, 2026)

    # the vintage average is a different number and keeps its own slot
    def test_the_2024_vintage_is_untouched(self):
        self.assertEqual(self.metro["years"]["2024"]["hpi"], 335.55)
        self.assertNotEqual(self.metro["latest"]["hpi"], self.metro["years"]["2024"]["hpi"])

    def test_a_metro_without_a_series_has_no_latest_hpi(self):
        centroids = bm.load_centroids(bm.DEFAULT_PATHS["centroids"])
        bare = bm.build_metros(self.rows, centroids)[0][0]
        self.assertIsNone(bare["latest"].get("hpi"))


class TestFootprintChange(unittest.TestCase):
    def salisbury(self):
        merged = bm.load_merged(bm.DEFAULT_PATHS["merged"])
        return merged[merged["cbsa_code"] == "41540"]

    def test_growth_is_null_when_the_footprint_changed_between_vintages(self):
        merged = self.salisbury()
        names = {int(row["year"]): row["NAME"] for _, row in merged.iterrows()}
        # precondition: the footprint really did change between 2014 and 2024
        self.assertEqual(names[2014], "Salisbury, MD-DE Metro Area")
        self.assertEqual(names[2024], "Salisbury, MD Metro Area")

        centroids = bm.load_centroids(bm.DEFAULT_PATHS["centroids"])
        metros, _, _ = bm.build_metros(merged, centroids)
        self.assertEqual(len(metros), 1)
        self.assertIsNone(metros[0]["growth"]["pop_14_24"])

    # the same-footprint pair keeps its number, so the guard cannot simply blank
    # every rate on a metro that changed once
    def test_growth_survives_when_the_footprint_held(self):
        merged = self.salisbury()
        centroids = bm.load_centroids(bm.DEFAULT_PATHS["centroids"])
        metros, _, _ = bm.build_metros(merged, centroids)
        self.assertEqual(metros[0]["growth"]["hpi_14_19"], 0.1469)

    # omb renames the principal cities without moving a county line. bakersfield
    # is kern county in both vintages and austin's san marcos sits in hays, which
    # the metro already had. an earlier guard compared the whole name and blanked
    # 78 metros that had only been renamed, so the state list is the test
    def test_a_renamed_metro_keeps_its_growth(self):
        merged = bm.load_merged(bm.DEFAULT_PATHS["merged"])
        centroids = bm.load_centroids(bm.DEFAULT_PATHS["centroids"])
        for cbsa, was, now in (
            ("12540", "Bakersfield, CA Metro Area", "Bakersfield-Delano, CA Metro Area"),
            ("12420", "Austin-Round Rock, TX Metro Area", "Austin-Round Rock-San Marcos, TX Metro Area"),
        ):
            rows = merged[merged["cbsa_code"] == cbsa]
            names = {int(r["year"]): r["NAME"] for _, r in rows.iterrows()}
            # precondition: renamed, same states
            self.assertEqual(names[2014], was)
            self.assertEqual(names[2024], now)
            metros, _, _ = bm.build_metros(rows, centroids)
            self.assertIsNotNone(metros[0]["growth"]["pop_14_24"], cbsa)

    # a metro that gained or lost a state really was redrawn
    def test_a_state_leaving_the_name_blanks_the_growth(self):
        merged = bm.load_merged(bm.DEFAULT_PATHS["merged"])
        centroids = bm.load_centroids(bm.DEFAULT_PATHS["centroids"])
        for cbsa in ("21780", "35084", "49340"):
            rows = merged[merged["cbsa_code"] == cbsa]
            metros, _, _ = bm.build_metros(rows, centroids)
            self.assertIsNone(metros[0]["growth"]["pop_14_24"], cbsa)

    def test_name_states_reads_both_lists_off_a_division(self):
        self.assertEqual(bm.name_states("Salisbury, MD-DE Metro Area"), ["MD-DE"])
        self.assertEqual(
            bm.name_states("Chicago-Naperville-Schaumburg, IL Metro Division; Chicago-Naperville-Elgin, IL-IN Metro Area"),
            ["IL", "IL-IN"],
        )
        self.assertIsNone(bm.name_states(None))

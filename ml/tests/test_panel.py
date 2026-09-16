import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from loop import panel, spec

FHFA_ROW = {"level": "MSA", "frequency": "quarterly", "hpi_type": "traditional", "hpi_flavor": "all-transactions"}


def spine(codes, quarters):
    rows = [(code, quarter) for code in codes for quarter in quarters]
    return pd.DataFrame(rows, columns=["cbsa_code", "quarter"])


def long_rows(code, metric, values):
    return [{"cbsa_code": code, "metric": metric, "period": period, "value": value} for period, value in values.items()]


def gazetteer():
    return pd.DataFrame({
        "cbsa_code": ["10180", "16984", "16980"],
        "name": ["Abilene, TX Metro Area", "Chicago-Naperville-Schaumburg, IL Metro Division",
                 "Chicago-Naperville-Elgin, IL-IN Metro Area"],
        "cbsa_type": ["1", "3", "1"],
        "parent_cbsa": [None, "16980", None],
    })


class TestFhfa(unittest.TestCase):
    def test_filter_keeps_the_one_series_per_metro(self):
        rows = []
        for quarter, value in ((1, 100.0), (2, 101.0)):
            base = {"place_id": "10180", "yr": 2020, "period": quarter}
            rows.append({**FHFA_ROW, **base, "index_nsa": value})
            rows.append({**FHFA_ROW, **base, "hpi_flavor": "purchase-only", "index_nsa": 999.0})
            rows.append({**FHFA_ROW, **base, "hpi_type": "distress-free", "index_nsa": 999.0})
            rows.append({**FHFA_ROW, **base, "frequency": "monthly", "index_nsa": 999.0})
            rows.append({**FHFA_ROW, **base, "level": "State", "place_id": "TX", "index_nsa": 999.0})
        out = panel.fhfa_series(pd.DataFrame(rows))
        self.assertEqual(out["cbsa_code"].tolist(), ["10180", "10180"])
        self.assertEqual(out["quarter"].tolist(), ["2020Q1", "2020Q2"])
        self.assertEqual(out["hpi"].tolist(), [100.0, 101.0])

    def test_two_series_for_one_metro_raise(self):
        rows = [{**FHFA_ROW, "place_id": "10180", "yr": 2020, "period": 1, "index_nsa": v} for v in (100.0, 101.0)]
        with self.assertRaises(ValueError):
            panel.fhfa_series(pd.DataFrame(rows))


class TestLogDiff(unittest.TestCase):
    def frame(self):
        return pd.DataFrame({
            "cbsa_code": ["a", "a", "a", "b", "b"],
            "quarter": ["2020Q1", "2020Q2", "2020Q3", "2020Q1", "2020Q2"],
            "hpi": [100.0, 110.0, 121.0, 50.0, 100.0],
        })

    def test_change_stays_inside_a_metro(self):
        change = panel.log_diff(self.frame(), "hpi", 1)
        self.assertTrue(np.isnan(change[0]))
        self.assertAlmostEqual(change[1], np.log(1.1))
        self.assertAlmostEqual(change[2], np.log(1.1))
        self.assertTrue(np.isnan(change[3]))
        self.assertAlmostEqual(change[4], np.log(2.0))

    def test_gap_gives_null_not_a_change_over_the_wrong_span(self):
        frame = pd.DataFrame({
            "cbsa_code": ["a", "a", "a"],
            "quarter": ["2020Q1", "2020Q2", "2020Q4"],
            "hpi": [100.0, 110.0, 121.0],
        })
        one = panel.log_diff(frame, "hpi", 1)
        two = panel.log_diff(frame, "hpi", 2)
        self.assertTrue(np.isnan(one[2]))
        self.assertAlmostEqual(two[2], np.log(1.1))
        self.assertTrue(np.isnan(two[1]))

    def test_row_order_does_not_matter(self):
        frame = self.frame()
        shuffled = frame.sample(frac=1.0, random_state=spec.SEED)
        change = panel.log_diff(shuffled, "hpi", 1)
        self.assertAlmostEqual(change[4], np.log(2.0))
        self.assertTrue(np.isnan(change[3]))


class TestQuarterMeans(unittest.TestCase):
    def test_mean_of_months_skips_the_annual_average(self):
        frame = pd.DataFrame({
            "cbsa_code": ["x"] * 7, "year": [2020] * 7,
            "period": ["M01", "M02", "M03", "M13", "M04", "M05", "M06"],
            "value": [4.0, 5.0, 6.0, 99.0, 7.0, 8.0, 9.0],
        })
        out = panel.quarter_mean_of_months(frame).set_index("quarter")["value"]
        self.assertEqual(len(out), 2)
        self.assertAlmostEqual(out["2020Q1"], 5.0)
        # 99 is the year's own average, not a thirteenth month
        self.assertAlmostEqual(out["2020Q2"], 8.0)

    # the audit wanted a short quarter dropped. it was tried and measured: the
    # only short quarter in the panel is 2025Q4, october 2025 was never
    # published because of the shutdown, and dropping it sent 385 metros back
    # to the 2024 annual average. two real months of the quarter beat a number
    # from the year before
    def test_a_short_quarter_keeps_the_months_it_has(self):
        frame = pd.DataFrame({
            "cbsa_code": ["x"] * 5,
            "year": [2025] * 5,
            "period": ["M07", "M08", "M09", "M11", "M12"],
            "value": [4.0, 5.0, 6.0, 3.2, 3.4],
        })
        out = panel.quarter_mean_of_months(frame).set_index("quarter")["value"]
        self.assertAlmostEqual(out["2025Q3"], 5.0)
        self.assertAlmostEqual(out["2025Q4"], 3.3)

    # a month that came back null is not a month that was published
    def test_a_null_month_is_not_averaged_as_a_value(self):
        frame = pd.DataFrame({
            "cbsa_code": ["x"] * 3,
            "year": [2026] * 3,
            "period": ["M01", "M02", "M03"],
            "value": [4.0, 6.0, float("nan")],
        })
        out = panel.quarter_mean_of_months(frame).set_index("quarter")["value"]
        self.assertAlmostEqual(out["2026Q1"], 5.0)

    def test_mean_of_dates_by_quarter(self):
        frame = pd.DataFrame({
            "date": ["2024-10-04", "2024-11-01", "2024-12-27", "2025-01-03"],
            "value": [6.0, 7.0, 8.0, 5.0],
        })
        out = panel.quarter_mean_of_dates(frame).set_index("quarter")["value"]
        self.assertAlmostEqual(out["2024Q4"], 7.0)
        self.assertAlmostEqual(out["2025Q1"], 5.0)


class TestAsOf(unittest.TestCase):
    def test_annual_value_is_known_from_the_next_first_quarter(self):
        annual = pd.DataFrame({"cbsa_code": ["x", "x"], "year": [2019, 2020], "value": [1.0, 2.0]})
        quarters = ["2019Q3", "2019Q4", "2020Q1", "2020Q4", "2021Q1", "2023Q2"]
        out = panel.annual_as_of(annual, spine(["x"], quarters)).tolist()
        self.assertTrue(np.isnan(out[0]))
        self.assertTrue(np.isnan(out[1]))
        self.assertEqual(out[2:], [1.0, 1.0, 2.0, 2.0])

    def test_annual_value_never_crosses_metros(self):
        annual = pd.DataFrame({"cbsa_code": ["x"], "year": [2019], "value": [1.0]})
        out = panel.annual_as_of(annual, spine(["x", "y"], ["2020Q1"]))
        self.assertEqual(out[0], 1.0)
        self.assertTrue(np.isnan(out[1]))

    def test_monthly_value_is_read_at_the_quarters_last_month(self):
        monthly = pd.DataFrame({"cbsa_code": ["x"] * 3, "month": ["2020-02", "2020-03", "2020-04"], "value": [1.0, 2.0, 3.0]})
        out = panel.monthly_as_of(monthly, spine(["x"], ["2019Q4", "2020Q1", "2020Q2"])).tolist()
        self.assertTrue(np.isnan(out[0]))
        self.assertEqual(out[1], 2.0)
        self.assertTrue(np.isnan(out[2]))

    def test_split_periods_by_shape(self):
        long = pd.DataFrame({"cbsa_code": ["x"] * 3, "period": ["2019", "2020-06", "bad"], "value": [1.0, 2.0, 3.0]})
        annual, monthly = panel.split_periods(long)
        self.assertEqual(annual["year"].tolist(), [2019])
        self.assertEqual(monthly["month"].tolist(), ["2020-06"])

    def test_month_wins_over_the_lagged_year(self):
        long = pd.DataFrame({"cbsa_code": ["x", "x"], "period": ["2019", "2020-06"], "value": [1.0, 5.0]})
        out = panel.as_of(long, spine(["x"], ["2020Q1", "2020Q2", "2020Q3"])).tolist()
        self.assertEqual(out, [1.0, 5.0, 1.0])

    def test_attach_refuses_duplicate_keys(self):
        part = pd.DataFrame({"quarter": ["2020Q1", "2020Q1"], "value": [1.0, 2.0]})
        with self.assertRaises(ValueError):
            panel.attach(spine(["x"], ["2020Q1"]), part, ["quarter"])


class TestUnemployment(unittest.TestCase):
    def test_months_first_then_the_lagged_annual_average(self):
        bls = pd.DataFrame({
            "cbsa_code": ["x"] * 5, "year": [2019, 2020, 2021, 2021, 2021],
            "period": ["M13", "M13", "M07", "M08", "M09"], "value": [3.0, 9.0, 5.0, 6.0, 7.0],
        })
        out = panel.unemployment(bls, spine(["x"], ["2019Q4", "2020Q2", "2021Q1", "2021Q3"])).tolist()
        self.assertTrue(np.isnan(out[0]))
        self.assertEqual(out[1:], [3.0, 9.0, 6.0])

    # a quarter with some months uses them; only a quarter with none at all
    # falls back to the annual rule
    def test_only_a_quarter_with_no_months_takes_the_annual_average(self):
        bls = pd.DataFrame({
            "cbsa_code": ["x"] * 5, "year": [2020, 2021, 2021, 2021, 2021],
            "period": ["M13", "M07", "M08", "M09", "M11"], "value": [9.0, 5.0, 6.0, 7.0, 3.3],
        })
        out = panel.unemployment(bls, spine(["x"], ["2021Q3", "2021Q4", "2022Q1"])).tolist()
        self.assertEqual(out[0], 6.0)
        self.assertEqual(out[1], 3.3)
        self.assertEqual(out[2], 9.0)


class TestEnrichment(unittest.TestCase):
    def metrics(self):
        rows = long_rows("x", "pop_estimate", {"2019": 1000.0, "2020": 1100.0})
        rows += long_rows("x", "permits_units", {"2020": 22.0})
        rows += long_rows("x", "bea_income_per_capita", {"2019": 50.0, "2020": 55.0})
        rows += long_rows("x", "domestic_migration_rate", {"2020": 3.5})
        rows += long_rows("x", "median_listing_price", {"2019": 200.0, "2020": 210.0, "2020-06": 300.0, "2021-06": 330.0})
        rows += long_rows("x", "inventory", {"2019": 100.0, "2020": 90.0})
        return pd.DataFrame(rows)

    def value(self, features, metric, period):
        rows = features[(features["metric"] == metric) & (features["period"] == period)]
        return float(rows["value"].iloc[0]) if len(rows) else None

    def test_derived_features(self):
        features = panel.enrichment_features(self.metrics())
        self.assertAlmostEqual(self.value(features, "permits_per_1000", "2020"), 20.0)
        self.assertAlmostEqual(self.value(features, "pop_growth", "2020"), np.log(1.1))
        self.assertIsNone(self.value(features, "pop_growth", "2019"))
        self.assertAlmostEqual(self.value(features, "income_growth", "2020"), np.log(1.1))
        self.assertAlmostEqual(self.value(features, "domestic_migration_rate", "2020"), 3.5)
        self.assertAlmostEqual(self.value(features, "listing_price_yoy", "2020"), np.log(1.05))
        self.assertAlmostEqual(self.value(features, "listing_price_yoy", "2021-06"), np.log(1.1))
        self.assertIsNone(self.value(features, "listing_price_yoy", "2020-06"))
        self.assertAlmostEqual(self.value(features, "inventory_yoy", "2020"), np.log(0.9))

    def test_year_over_year_needs_the_prior_year(self):
        annual = pd.DataFrame({"cbsa_code": ["x", "x"], "year": [2018, 2020], "value": [1.0, 2.0]})
        out = panel.annual_log_change(annual)
        self.assertTrue(out["value"].isna().all())

    # the audit asked for the opposite of this and it would have been a defect:
    # the parent is a larger geography, so a year by year fill puts chicago's
    # 9.4 million next to gary's 719 thousand and calls the step a growth rate
    def test_a_division_holding_part_of_a_metric_inherits_none_of_it(self):
        long = pd.DataFrame({
            "cbsa_code": ["p", "p", "p", "d", "q"],
            "metric": ["pop", "pop", "other", "pop", "pop"],
            "period": ["2019", "2020", "2020", "2020", "2020"],
            "value": [9_435_971.0, 9_500_000.0, 1.0, 718_960.0, 5.0],
        })
        out = panel.inherit_from_parent(long, {"d": "p"})
        mine = out[out["cbsa_code"] == "d"]
        pop = mine[mine["metric"] == "pop"]
        self.assertEqual(list(pop["period"]), ["2020"])
        self.assertEqual(float(pop["value"].iloc[0]), 718_960.0)
        # a metric it has none of still comes over whole
        self.assertEqual(set(mine["metric"]), {"pop", "other"})
        # and no year of the parent's own series leaked in
        self.assertNotIn(9_435_971.0, set(mine["value"]))

    def test_the_derived_growth_never_crosses_the_seam(self):
        long = pd.DataFrame({
            "cbsa_code": ["p", "p", "d"],
            "metric": ["pop_estimate"] * 3,
            "period": ["2019", "2020", "2020"],
            "value": [9_435_971.0, 9_500_000.0, 718_960.0],
        })
        features = panel.enrichment_features(panel.inherit_from_parent(long, {"d": "p"}))
        growth = features[(features["cbsa_code"] == "d") & (features["metric"] == "pop_growth")]
        self.assertTrue(growth.empty or growth["value"].isna().all())

    def test_division_takes_missing_metrics_from_its_parent(self):
        long = pd.DataFrame({
            "cbsa_code": ["p", "p", "d"], "metric": ["a", "b", "a"],
            "period": ["2020"] * 3, "value": [1.0, 2.0, 3.0],
        })
        out = panel.inherit_from_parent(long, {"d": "p", "orphan": "nobody"})
        division = out[out["cbsa_code"] == "d"].set_index("metric")["value"]
        self.assertEqual(division["a"], 3.0)
        self.assertEqual(division["b"], 2.0)
        self.assertEqual(len(out), 4)
        self.assertEqual((out["cbsa_code"] == "p").sum(), 2)


# a source on disk that hands back nothing is not the same as a source that is
# not there. the second is declared in the manifest, the first used to leave a
# feature null in every row of the panel with nobody the wiser
class TestSilentlyEmptySource(unittest.TestCase):
    def have(self, present=True):
        return {name: {"path": f"data/raw/{name}/metrics.csv", "present": present}
                for name in panel.ENRICHMENT}

    def raw_dir(self, rows):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        for source, metrics in panel.ENRICHMENT.items():
            (root / source).mkdir(parents=True)
            frame = pd.DataFrame(rows.get(source, [
                {"cbsa_code": "10180", "metric": metric, "period": "2020", "value": 1.0}
                for metric in metrics
            ]))
            if frame.empty:
                frame = pd.DataFrame(columns=["cbsa_code", "metric", "period", "value"])
            frame.to_csv(root / source / "metrics.csv", index=False)
        return root

    def test_a_metric_that_never_arrives_is_refused(self):
        root = self.raw_dir({"pep": [
            {"cbsa_code": "10180", "metric": "population", "period": "2020", "value": 1.0},
        ]})
        with self.assertRaises(ValueError) as raised:
            panel.read_metrics(root, self.have())
        self.assertIn("pep", str(raised.exception))
        self.assertIn("pop_estimate", str(raised.exception))

    def test_an_empty_file_is_refused(self):
        root = self.raw_dir({"realtor": []})
        with self.assertRaises(ValueError) as raised:
            panel.read_metrics(root, self.have())
        self.assertIn("realtor", str(raised.exception))

    # a column of text parses to all nulls, which is no data either
    def test_values_that_are_all_unparsable_are_refused(self):
        root = self.raw_dir({"bps": [
            {"cbsa_code": "10180", "metric": "permits_units", "period": "2020", "value": "N/A"},
        ]})
        with self.assertRaises(ValueError) as raised:
            panel.read_metrics(root, self.have())
        self.assertIn("permits_units", str(raised.exception))

    def test_every_source_delivering_passes(self):
        out = panel.read_metrics(self.raw_dir({}), self.have())
        self.assertEqual(set(out["metric"]), {m for ms in panel.ENRICHMENT.values() for m in ms})

    # an absent source is the declared case, it stays quiet
    def test_absent_sources_are_not_refused(self):
        out = panel.read_metrics(self.raw_dir({}), self.have(present=False))
        self.assertTrue(out.empty)

    def test_a_feature_null_in_every_row_is_refused(self):
        frame = pd.DataFrame({name: [np.nan, np.nan] for name in panel.ENRICHMENT_FEATURES})
        frame["inventory_yoy"] = [np.nan, np.nan]
        frame["pop_growth"] = [0.01, 0.02]
        frame["domestic_migration_rate"] = [1.0, 2.0]
        frame["permits_per_1000"] = [3.0, 4.0]
        frame["income_growth"] = [0.03, 0.04]
        frame["listing_price_yoy"] = [0.05, 0.06]
        with self.assertRaises(ValueError) as raised:
            panel.check_features(frame, self.have())
        self.assertIn("inventory_yoy", str(raised.exception))

    # the same all null column is expected when the source it needs is absent
    def test_a_null_feature_is_allowed_when_its_source_is_missing(self):
        frame = pd.DataFrame({name: [1.0, 2.0] for name in panel.ENRICHMENT_FEATURES})
        frame["inventory_yoy"] = [np.nan, np.nan]
        have = self.have()
        have["zillow_extras"]["present"] = False
        panel.check_features(frame, have)


class TestStaticAndZillow(unittest.TestCase):
    def test_names_levels_and_parents(self):
        out = panel.static_columns(["10180", "16984"], gazetteer()).set_index("cbsa_code")
        self.assertEqual(out.loc["10180", "name"], "Abilene, TX")
        self.assertEqual(out.loc["16984", "name"], "Chicago-Naperville-Schaumburg, IL")
        self.assertEqual(out["level"].tolist(), ["msa", "division"])
        self.assertTrue(pd.isna(out.loc["10180", "parent_cbsa"]))
        self.assertEqual(out.loc["16984", "parent_cbsa"], "16980")

    def test_zillow_match_by_first_city_and_through_the_parent(self):
        wide = pd.DataFrame({"2020-03-31": [1.0, 2.0], "2020-06-30": [3.0, 4.0]},
                            index=pd.Index(["Chicago, IL", "Abilene, TX"], name="RegionName"))
        metros = pd.DataFrame({
            "cbsa_code": ["10180", "16984"], "level": ["msa", "division"], "parent_cbsa": [None, "16980"],
            "place_name": ["Abilene, TX", "Chicago-Naperville-Schaumburg, IL (MSAD)"],
        })
        lookup = panel.zillow_lookup(metros, gazetteer(), wide)
        self.assertEqual(lookup, {"10180": "Abilene, TX", "16984": "Chicago, IL"})
        long = panel.zillow_long(wide, lookup)
        out = panel.monthly_as_of(long, spine(["16984", "10180"], ["2020Q1", "2020Q2"])).tolist()
        self.assertEqual(out, [1.0, 3.0, 2.0, 4.0])


class TestContract(unittest.TestCase):
    def test_columns_are_ordered_and_drift_is_refused(self):
        frame = pd.DataFrame({column: [0] for column in reversed(spec.PANEL_COLUMNS)})
        self.assertEqual(list(panel.contract(frame).columns), spec.PANEL_COLUMNS)
        with self.assertRaises(ValueError):
            panel.contract(frame.drop(columns=["zori"]))
        with self.assertRaises(ValueError):
            panel.contract(frame.assign(extra=1))

    def test_coverage_counts_metros_with_a_value_in_the_year(self):
        frame = pd.DataFrame({column: [np.nan] * 4 for column in spec.PANEL_COLUMNS})
        frame["cbsa_code"] = ["a", "a", "b", "b"]
        frame["quarter"] = ["2020Q1", "2021Q1", "2020Q1", "2021Q1"]
        frame["hpi"] = [1.0, 1.0, np.nan, 1.0]
        table = panel.coverage_table(frame)
        self.assertEqual(table.loc["hpi", 2020], 0.5)
        self.assertEqual(table.loc["hpi", 2021], 1.0)
        self.assertEqual(table.loc["unemp", 2020], 0.0)


@unittest.skipUnless((spec.RAW_DIR / "fhfa" / "hpi_master.csv").exists(), "raw files not on this machine")
class TestRealFiles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.frame = panel.build()

    def test_build_on_the_real_files(self):
        frame = self.frame
        self.assertEqual(list(frame.columns), spec.PANEL_COLUMNS)
        self.assertEqual(frame["cbsa_code"].nunique(), 410)
        self.assertFalse(frame.duplicated(spec.KEY).any())
        self.assertGreaterEqual(spec.to_period(frame["quarter"].min()), spec.to_period("1975Q1"))
        self.assertGreaterEqual(spec.to_period(frame["quarter"].max()), spec.to_period("2026Q2"))
        chicago = frame[(frame["cbsa_code"] == "16984") & (frame["quarter"] == "2020Q2")]
        self.assertEqual(len(chicago), 1)
        self.assertFalse(np.isnan(chicago["unemp"].iloc[0]))
        self.assertEqual(chicago["level"].iloc[0], "division")
        self.assertEqual(chicago["parent_cbsa"].iloc[0], "16980")
        late = frame[frame["quarter"] == "2024Q4"]["mortgage"]
        self.assertEqual(late.nunique(), 1)
        self.assertFalse(late.isna().any())
        with tempfile.TemporaryDirectory() as tmp:
            info = panel.write(frame, Path(tmp) / "panel.parquet", Path(tmp) / "manifest.json")
            self.assertEqual(info["rows"], len(frame))
            self.assertEqual(info["non_null_share"]["hpi"], 1.0)
            self.assertEqual(json.loads((Path(tmp) / "manifest.json").read_text())["metros"], 410)

    # realtor, zillow extras and the permit folder publish at the msa level
    # only, so a division carries those columns only because build lets it
    # take its parent's rows. drop that and 37 metros lose a decade each
    def test_a_division_inherits_what_its_sources_never_publish(self):
        divisions = self.frame[self.frame["level"] == "division"]
        self.assertEqual(divisions["cbsa_code"].nunique(), 37)
        for name in ("listing_price_yoy", "inventory_yoy", "permits_per_1000"):
            self.assertGreater(int(divisions[name].notna().sum()), 500, name)
        chicago = divisions[divisions["cbsa_code"] == "16984"]
        self.assertEqual(chicago["parent_cbsa"].iloc[0], "16980")
        self.assertTrue(chicago["listing_price_yoy"].notna().any())


if __name__ == "__main__":
    unittest.main()

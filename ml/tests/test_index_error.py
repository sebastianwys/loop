# fhfa's rstderr in hpi_exp_metro.txt is a relative standard error, already a
# percent of the index. fhfa's technical note for the 2026q1 expansion calls it
# that in words: "the relative standard errors for wheeling, wv-oh averaged 3.3
# percent for the expanded-data index", with "medians of 1.8 percent" over all
# 410 areas, 2020q1 to 2025q3. the file agrees. over those quarters wheeling's
# rstderr averages 3.45 and the 410 metro median is 2.16, while rstderr over
# the index level would give 1.07 and 0.59.
#
# so the number the map shows is fhfa's number, rstderr at the origin,
# unchanged. dividing it by the index level again would divide each metro's
# error by its price growth since 1991q1, where every metro is 100, and print
# it 2 to 11 times too small. the tests read the expected values off the raw
# file, so a later fhfa pull does not break them.
#
# the model reads the raw hpi_rstderr through spec.FEATURES, which is already
# the percent form.

import csv
import json
import math
import unittest

import pandas as pd

from loop import export, panel, spec

EXPANDED = spec.RAW_DIR / "fhfa" / "hpi_exp_metro.txt"
SHIPPED_METRICS = spec.FORECAST_DIR / "metrics.csv"
MAP_DATA = spec.REPO_ROOT / "web" / "public" / "data" / "metros.json"

# named metros across the range of the error
NAMED = {"10180": "Abilene", "19740": "Denver", "25980": "Hinesville", "14580": "Bozeman", "48540": "Wheeling"}

# a shipped file may lag a newer fhfa pull by one release, and fhfa revises an
# error by a few hundredths as sales arrive (chicago 2025q4 went 0.44 to 0.41).
# ten percent allows that and still refuses a factor of two
DRIFT = 0.10


# fhfa's rstderr by metro and quarter, read with the csv module so the
# expectation never passes through panel.py
def published_rstderr():
    out = {}
    with open(EXPANDED, newline="") as handle:
        for row in csv.DictReader(handle, delimiter="\t"):
            if row["rstderr"] in ("", None) or row["index_nsa"] in ("", None):
                continue
            out[(row["city"].zfill(5), f"{row['yr']}Q{row['qtr']}")] = float(row["rstderr"])
    return out


# one forecast row per metro and horizon at the origin, so build_metrics has
# an origin to export. the values do not matter here, the index error rides
# along from the panel
def forecasts_at(origin, codes):
    rows = []
    for code in codes:
        for h in spec.HORIZONS:
            rows.append({"cbsa_code": code, "origin": origin, "horizon": h, "q10": -0.02, "q50": 0.0, "q90": 0.02,
                         "lo": -0.03, "hi": 0.03, "q50_pct": 0.0, "lo_pct": -2.96, "hi_pct": 3.05, "model": "seqgru"})
    return pd.DataFrame(rows)


def quarter_of_period(period):
    return spec.quarter_of(pd.Timestamp(f"{period}-01"))


@unittest.skipUnless(EXPANDED.exists() and (spec.RAW_DIR / "fhfa" / "hpi_master.csv").exists(),
                     "raw fhfa files not on this machine")
class TestTheExportedIndexErrorIsFhfasNumber(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.published = published_rstderr()
        cls.frame = panel.build()
        cls.origin = str(cls.frame["quarter"].max())
        codes = sorted(cls.frame["cbsa_code"].unique())
        metrics = export.build_metrics(forecasts_at(cls.origin, codes), cls.frame)
        cls.exported = metrics[metrics["metric"] == "hpi_index_error"].set_index("cbsa_code")["value"].astype(float)

    def test_the_named_metros_show_fhfas_error_at_the_origin(self):
        for code, name in NAMED.items():
            with self.subTest(metro=name):
                expected = self.published[(code, self.origin)]
                self.assertAlmostEqual(float(self.exported[code]), expected, places=2,
                                       msg=f"{name} {code} at {self.origin}: fhfa publishes {expected}")

    def test_every_metro_shows_fhfas_error_at_the_origin(self):
        expected = pd.Series({code: v for (code, q), v in self.published.items() if q == self.origin})
        both = pd.concat([self.exported.rename("shown"), expected.rename("fhfa")], axis=1, join="inner")
        self.assertGreater(len(both), 0)
        off = both[(both["shown"] - both["fhfa"]).abs() > 0.005]
        ratio = (both["shown"] / both["fhfa"]).describe()
        self.assertEqual(len(off), 0,
                         f"{len(off)} of {len(both)} metros show an index error that is not fhfa's at {self.origin}; "
                         f"shown over published runs {ratio['min']:.2f} to {ratio['max']:.2f}, median {ratio['50%']:.2f}")

    # a panel column documented as the standard error as a share of the index
    # is rstderr itself, so the two are one number at every metro and quarter.
    # it skips while the panel carries no such column
    def test_the_panels_share_of_the_index_is_fhfas_number_everywhere(self):
        if "hpi_rstderr_rel" not in spec.PANEL_COLUMNS:
            self.skipTest("the panel carries no separate share of index column")
        rel = self.frame.set_index(spec.KEY)["hpi_rstderr_rel"]
        expected = pd.Series(self.published)
        expected.index = pd.MultiIndex.from_tuples(expected.index, names=spec.KEY)
        both = pd.concat([rel.rename("panel"), expected.rename("fhfa")], axis=1, join="inner").dropna()
        both = both[both["fhfa"] > 0]
        self.assertGreater(len(both), 50000)
        off = both[(both["panel"] - both["fhfa"]).abs() > 0.005]
        self.assertEqual(len(off), 0,
                         f"{len(off)} of {len(both)} metro quarters carry a share of the index that is not fhfa's "
                         f"rstderr; median panel over fhfa {float((off['panel'] / off['fhfa']).median()):.2f}")


# the files the map and the pages actually read, as they are committed
@unittest.skipUnless(EXPANDED.exists() and SHIPPED_METRICS.exists(), "shipped export or raw fhfa file not on disk")
class TestTheShippedFilesCarryFhfasNumber(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.published = published_rstderr()

    def assert_within_drift(self, shown, where):
        pairs = [(code, value, self.published.get((code, quarter))) for code, quarter, value in shown]
        pairs = [(code, value, fhfa) for code, value, fhfa in pairs if fhfa is not None and fhfa > 0]
        self.assertGreater(len(pairs), 0)
        off = [(code, value, fhfa) for code, value, fhfa in pairs if abs(value / fhfa - 1.0) > DRIFT]
        named = [f"{NAMED[c]} shows {v} for fhfa's {f}" for c, v, f in off if c in NAMED]
        self.assertEqual(len(off), 0, f"{where}: {len(off)} of {len(pairs)} metros are off fhfa's rstderr by more "
                                      f"than {DRIFT:.0%}; " + "; ".join(named))

    def test_the_exported_metrics_file(self):
        metrics = pd.read_csv(SHIPPED_METRICS, dtype={"cbsa_code": str, "period": str})
        rows = metrics[metrics["metric"] == "hpi_index_error"]
        shown = [(c, quarter_of_period(p), float(v)) for c, p, v in zip(rows["cbsa_code"], rows["period"], rows["value"])]
        self.assert_within_drift(shown, "ml/results/forecast/metrics.csv")

    @unittest.skipUnless(MAP_DATA.exists(), "web/public/data/metros.json not on disk")
    def test_the_map_data_file(self):
        metros = json.loads(MAP_DATA.read_text())["metros"]
        shown = []
        for metro in metros:
            latest = metro.get("latest") or {}
            value, period = latest.get("hpi_index_error"), latest.get("hpi_index_error_date")
            if value is None or period is None or (isinstance(value, float) and math.isnan(value)):
                continue
            shown.append((metro["cbsa"], quarter_of_period(period), float(value)))
        self.assert_within_drift(shown, "web/public/data/metros.json")


if __name__ == "__main__":
    unittest.main()

import hashlib
import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pandas as pd

from loop import export, spec

ORIGIN = "2026Q2"
FORECAST_METROS = ["10180", "00420", "99999"]


# the n quarters ending at the origin, oldest first
def quarters(n):
    return [spec.shift_quarter(ORIGIN, i - n + 1) for i in range(n)]


# abilene has five years of prices: 100 twenty quarters back, 150 / 1.06 four
# quarters back and 150 at the origin, straight lines in between. metro 00420
# has six quarters at 3 percent a year. 99999 is not in the panel at all
def panel_frame():
    rows = []
    start, knee, end = math.log(100.0), math.log(150.0 / 1.06), math.log(150.0)
    for i, q in enumerate(quarters(21)):
        level = start + (knee - start) * i / 16 if i <= 16 else knee + (end - knee) * (i - 16) / 4
        rows.append({"cbsa_code": "10180", "quarter": q, "log_hpi": level})
    for i, q in enumerate(quarters(6)):
        rows.append({"cbsa_code": "00420", "quarter": q, "log_hpi": math.log(100.0) + math.log(1.03) * (i - 1) / 4})
    return pd.DataFrame(rows)


# every metro at every horizon for one origin: a percent a quarter plus a
# metro offset, with two log points of band either side
def forecast_frame(origin=ORIGIN):
    rows = []
    for j, code in enumerate(FORECAST_METROS):
        for h in spec.HORIZONS:
            q50 = 0.01 * h + 0.005 * j
            lo, hi = q50 - 0.02, q50 + 0.02
            rows.append({
                "cbsa_code": code, "origin": origin, "horizon": h,
                "q10": lo, "q50": q50, "q90": hi, "lo": lo, "hi": hi,
                "q50_pct": round(float(spec.pct(q50)), 4),
                "lo_pct": round(float(spec.pct(lo)), 4),
                "hi_pct": round(float(spec.pct(hi)), 4),
                "model": "gru",
            })
    return pd.DataFrame(rows)


# the backtest row the surprise reads, plus distractors: another block at the
# same key, the wrong origin, the wrong horizon and a metro without prices
def predictions_frame():
    def row(code, quarter, horizon, block, q50):
        return {"cbsa_code": code, "quarter": quarter, "horizon": horizon, "block": block, "y": math.log(1.06),
                "q10": q50 - 0.02, "q50": q50, "q90": q50 + 0.02, "lo": q50 - 0.03, "hi": q50 + 0.03}
    return pd.DataFrame([
        row("10180", "2025Q2", 4, "test", math.log(1.04)),
        row("10180", "2025Q2", 4, "train", math.log(1.10)),
        row("10180", "2025Q1", 4, "test", math.log(1.20)),
        row("10180", "2025Q2", 8, "test", math.log(1.30)),
        row("99999", "2025Q2", 4, "test", math.log(1.02)),
    ])


class ExportCase(unittest.TestCase):
    def setUp(self):
        self.forecasts = forecast_frame()
        self.panel = panel_frame()
        self.predictions = predictions_frame()
        self.metrics = export.build_metrics(self.forecasts, self.panel, self.predictions)

    def value(self, code, metric):
        rows = self.metrics[(self.metrics.cbsa_code == code) & (self.metrics.metric == metric)]
        return None if rows.empty else float(rows["value"].iloc[0])

    def metrics_of(self, code):
        return sorted(self.metrics[self.metrics.cbsa_code == code]["metric"])

    def forecast(self, code, horizon, column):
        rows = self.forecasts[(self.forecasts.cbsa_code == code) & (self.forecasts.horizon == horizon)]
        return float(rows[column].iloc[0])


class TestBuildMetrics(ExportCase):
    def test_every_metric_appears_in_the_contract_columns(self):
        self.assertEqual(list(self.metrics.columns), export.COLUMNS)
        self.assertEqual(sorted(self.metrics["metric"].unique()), sorted(export.METRICS))
        self.assertFalse(self.metrics.isna().any().any())
        self.assertFalse(self.metrics.duplicated(["cbsa_code", "metric"]).any())
        self.assertEqual(list(self.metrics["cbsa_code"]), sorted(self.metrics["cbsa_code"]))

    def test_period_is_the_last_month_of_the_origin_quarter(self):
        self.assertEqual(set(self.metrics["period"]), {"2026-06"})
        self.assertEqual(export.period_of("2025Q4"), "2025-12")
        self.assertEqual(export.period_of("2024Q1"), "2024-03")

    def test_forecast_metrics_read_the_percent_columns_at_their_horizon(self):
        for code in FORECAST_METROS:
            self.assertAlmostEqual(self.value(code, "hpi_forecast_4q"), self.forecast(code, 4, "q50_pct"), places=4)
            self.assertAlmostEqual(self.value(code, "hpi_forecast_4q_lo"), self.forecast(code, 4, "lo_pct"), places=4)
            self.assertAlmostEqual(self.value(code, "hpi_forecast_4q_hi"), self.forecast(code, 4, "hi_pct"), places=4)
            self.assertAlmostEqual(self.value(code, "hpi_forecast_8q"), self.forecast(code, 8, "q50_pct"), places=4)
            self.assertAlmostEqual(self.value(code, "hpi_forecast_8q_lo"), self.forecast(code, 8, "lo_pct"), places=4)
            self.assertAlmostEqual(self.value(code, "hpi_forecast_8q_hi"), self.forecast(code, 8, "hi_pct"), places=4)
        # the band sits around the point and the metros differ
        self.assertLess(self.value("10180", "hpi_forecast_4q_lo"), self.value("10180", "hpi_forecast_4q"))
        self.assertGreater(self.value("10180", "hpi_forecast_4q_hi"), self.value("10180", "hpi_forecast_4q"))
        self.assertNotEqual(self.value("10180", "hpi_forecast_4q"), self.value("00420", "hpi_forecast_4q"))

    # 150 against 150 / 1.06 is 6 percent, 150 against 100 over five years is
    # 1.5 to the power of one fifth, a little under 8.45 percent a year
    def test_realized_growth_by_hand(self):
        self.assertAlmostEqual(self.value("10180", "hpi_yoy_latest"), 6.0, places=4)
        self.assertAlmostEqual(self.value("10180", "hpi_trend_5y"), 100.0 * (1.5 ** 0.2 - 1.0), places=4)
        self.assertAlmostEqual(self.value("10180", "hpi_trend_5y"), 8.4472, places=4)
        self.assertAlmostEqual(self.value("00420", "hpi_yoy_latest"), 3.0, places=4)

    # abilene grew 6 percent, the model said 4 four quarters earlier
    def test_surprise_is_realized_minus_the_test_block_median_four_quarters_back(self):
        self.assertAlmostEqual(self.value("10180", "hpi_surprise_4q"), 2.0, places=4)
        self.assertIsNone(self.value("00420", "hpi_surprise_4q"))
        self.assertIsNone(self.value("99999", "hpi_surprise_4q"))

    def test_metro_missing_in_the_panel_keeps_only_its_forecasts(self):
        self.assertEqual(self.metrics_of("99999"), sorted(export.FORECAST_METRICS))

    def test_short_history_gives_the_year_but_not_the_trend(self):
        self.assertEqual(self.metrics_of("00420"), sorted(list(export.FORECAST_METRICS) + ["hpi_yoy_latest"]))

    def test_without_predictions_there_is_no_surprise(self):
        metrics = export.build_metrics(self.forecasts, self.panel)
        self.assertNotIn(export.SURPRISE_METRIC, set(metrics["metric"]))
        self.assertEqual(len(metrics), len(self.metrics) - 1)

    def test_only_the_newest_origin_is_exported(self):
        both = pd.concat([forecast_frame("2026Q1"), self.forecasts], ignore_index=True)
        metrics = export.build_metrics(both, self.panel, self.predictions)
        pd.testing.assert_frame_equal(metrics, self.metrics)

    def test_two_forecasts_for_one_metro_raise(self):
        extra = self.forecasts[self.forecasts.horizon == 4].iloc[:1]
        with self.assertRaises(ValueError):
            export.build_metrics(pd.concat([self.forecasts, extra], ignore_index=True), self.panel)
        with self.assertRaises(ValueError):
            export.build_metrics(self.forecasts.iloc[:0], self.panel)

    def test_integer_codes_get_their_leading_zero_back(self):
        forecasts = self.forecasts.assign(cbsa_code=self.forecasts["cbsa_code"].astype(int))
        metrics = export.build_metrics(forecasts, self.panel, self.predictions)
        self.assertEqual(sorted(metrics["cbsa_code"].unique()), ["00420", "10180", "99999"])
        pd.testing.assert_frame_equal(metrics, self.metrics)


class TestFiles(unittest.TestCase):
    def test_csv_keeps_leading_zeros_and_the_manifest_describes_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "metrics.csv"
            metrics = export.build_metrics(forecast_frame(), panel_frame(), predictions_frame())
            export.write_metrics(metrics, path)
            text = path.read_text()
            self.assertTrue(text.isascii())
            self.assertTrue(text.startswith("cbsa_code,metric,period,value\n"))
            self.assertIn("\n00420,hpi_forecast_4q,2026-06,", text)
            back = pd.read_csv(path, dtype={"cbsa_code": str})
            self.assertEqual(sorted(back["cbsa_code"].unique()), ["00420", "10180", "99999"])
            entry = export.manifest_entry(path, metrics, "gru", ORIGIN)
            self.assertEqual(list(entry), ["filename", "file_format", "source", "integrity", "version", "downloaded_at", "notes"])
            self.assertEqual(list(entry["source"]), ["endpoint", "provider", "access_method", "dataset"])
            self.assertEqual(list(entry["integrity"]), ["sha256", "size_kb", "row_count"])
            self.assertEqual(entry["source"]["provider"], "Loop forecasting model")
            self.assertEqual(entry["source"]["access_method"], "computed")
            self.assertEqual(entry["integrity"]["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(entry["integrity"]["row_count"], len(metrics))
            self.assertEqual(entry["version"], "gru, origin 2026Q2")
            self.assertEqual(entry["notes"]["period"], "2026-06")
            self.assertEqual(entry["notes"]["metros"], 3)
            self.assertEqual(entry["notes"]["rows_by_metric"]["hpi_surprise_4q"], 1)
            self.assertEqual(entry["notes"]["rows_by_metric"]["hpi_forecast_4q"], 3)

    def test_main_writes_the_csv_and_the_manifest_from_the_module_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            forecast_frame().to_csv(tmp / "forecasts.csv", index=False)
            panel_frame().to_parquet(tmp / "panel.parquet", index=False)
            predictions_frame().to_parquet(tmp / "predictions_gru.parquet", index=False)
            paths = {
                "FORECASTS_PATH": tmp / "forecasts.csv", "PANEL_PATH": tmp / "panel.parquet", "DATA_DIR": tmp,
                "METRICS_PATH": tmp / "out" / "metrics.csv", "MANIFEST_PATH": tmp / "out" / "download_manifest.json",
            }
            with mock.patch.multiple(export, **paths):
                export.main()
            manifest = json.loads((tmp / "out" / "download_manifest.json").read_text())
            csv_path = tmp / "out" / "metrics.csv"
            self.assertEqual(manifest[0]["filename"], "metrics.csv")
            self.assertEqual(manifest[0]["version"], "gru, origin 2026Q2")
            self.assertEqual(manifest[0]["integrity"]["sha256"], hashlib.sha256(csv_path.read_bytes()).hexdigest())
            self.assertEqual(sorted(manifest[0]["notes"]["inputs"]), ["forecasts.csv", "panel.parquet", "predictions_gru.parquet"])
            back = pd.read_csv(csv_path, dtype={"cbsa_code": str})
            self.assertIn("00420", set(back["cbsa_code"]))
            self.assertIn("hpi_surprise_4q", set(back["metric"]))
            self.assertEqual(len(back), manifest[0]["integrity"]["row_count"])


# a point forecast with no band is a contract break, not a metro with less data
class TestBandTravelsWithThePoint(unittest.TestCase):
    def test_a_null_band_edge_is_refused(self):
        forecasts = forecast_frame()
        forecasts.loc[forecasts["horizon"] == 4, "lo_pct"] = float("nan")
        with self.assertRaises(ValueError) as raised:
            export.build_metrics(forecasts, panel_frame())
        self.assertIn("hpi_forecast_4q_lo", str(raised.exception))

    def test_a_complete_band_passes(self):
        metrics = export.build_metrics(forecast_frame(), panel_frame())
        for metric in ("hpi_forecast_4q", "hpi_forecast_4q_lo", "hpi_forecast_4q_hi"):
            self.assertEqual(len(metrics[metrics["metric"] == metric]), len(FORECAST_METROS))


if __name__ == "__main__":
    unittest.main()

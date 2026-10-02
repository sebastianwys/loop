# the metrics contract names its key: a five digit cbsa code, and a period that
# is yyyy for an annual value or yyyy-mm for a monthly one. a key off the
# contract is refused. a period off it would be compared as a string, so
# 2026Q2 would read newer than 2026-07 and 2026-7 newer than 2026-10, and only
# a four digit period reaches a year panel, so 2024.0 would drop out of it. a
# code read as 10180.0 matches no metro and every cell would go null in
# silence. and a metric named x_date would write over the date latest keeps
# for x
#
# each file here is written into a temporary folder and put through the
# build's own discovery, and where it loads, what the map made of it is in the
# failure

import tempfile
import unittest
from pathlib import Path

import pandas as pd

from bot import build_map_data as bm

HEADER = "cbsa_code,metric,period,value\n"

MERGED = pd.DataFrame({"cbsa_code": ["10180"], "place_name": ["Abilene, TX"], "year": [2024],
                       "avg_index_nsa": [335.5], "geo_level": ["msa"], "parent_cbsa": [None]})
CENTROIDS = pd.DataFrame({"cbsa_code": ["10180"], "name": ["Abilene, TX Metro Area"],
                          "lat": [32.45], "lon": [-99.7]}).set_index("cbsa_code")

CORE_LATEST = {"zhvi", "zhvi_date", "zori", "zori_date", "unemp", "unemp_date", "hpi", "hpi_date"}


class TestAKeyOffTheContractIsRefused(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def discover(self, body):
        folder = Path(self.tmp.name) / "src"
        folder.mkdir(exist_ok=True)
        (folder / "metrics.csv").write_text(HEADER + body)
        return bm.discover_enrichments(self.tmp.name)

    # abilene's enrichment cells as the map would publish them
    def published(self, sources):
        metros, _, _ = bm.build_metros(MERGED, CENTROIDS, enrichments=sources)
        abilene = metros[0]
        years = {y: {k: v for k, v in panel.items() if k in sources[0]["metrics"]}
                 for y, panel in abilene["years"].items()}
        latest = {k: v for k, v in abilene["latest"].items() if k not in CORE_LATEST}
        return f"years {years}, latest {latest}"

    def assert_refused(self, body):
        try:
            sources = self.discover(body)
        except ValueError as refused:
            # a refusal says which file
            self.assertIn("src/metrics.csv", str(refused))
            return
        self.fail(f"loaded, and the map publishes {self.published(sources)}")

    def test_a_float_period_is_refused(self):
        self.assert_refused("10180,permits,2019,600\n10180,permits,2024.0,850\n")

    def test_a_quarter_is_refused(self):
        self.assert_refused("10180,listings,2026-07,120\n10180,listings,2026Q2,90\n")

    def test_an_unpadded_month_is_refused(self):
        self.assert_refused("10180,listings,2026-10,120\n10180,listings,2026-7,90\n")

    def test_a_month_past_twelve_is_refused(self):
        self.assert_refused("10180,listings,2026-10,120\n10180,listings,2026-13,90\n")

    def test_a_float_code_is_refused(self):
        self.assert_refused("10180.0,permits,2024,850\n")

    def test_a_short_code_is_refused(self):
        self.assert_refused("1018,permits,2024,850\n")

    def test_a_metric_named_like_a_date_is_refused(self):
        self.assert_refused("10180,x,2024,1\n10180,x_date,2024,5\n")

    # the control: a file on the contract loads, the annual value
    # reaches its panel and the newest period is latest
    def test_a_file_on_the_contract_loads(self):
        sources = self.discover("10180,permits,2019,600\n10180,permits,2024,850\n"
                                "10180,listings,2026-07,120\n10180,listings,2026-10,130\n")
        metros, _, _ = bm.build_metros(MERGED, CENTROIDS, enrichments=sources)
        abilene = metros[0]
        self.assertEqual(abilene["years"]["2024"]["permits"], 850.0)
        self.assertEqual((abilene["latest"]["listings"], abilene["latest"]["listings_date"]), (130.0, "2026-10"))

    # and a row whose value is not a number is still dropped, not refused
    def test_a_row_without_a_number_is_still_dropped(self):
        sources = self.discover("10180,permits,2024,n/a\n10180,permits,2019,600\n")
        self.assertEqual(len(sources[0]["groups"]["10180"]), 1)


if __name__ == "__main__":
    unittest.main()

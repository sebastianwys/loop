# red tests, not part of the green suite. run from the project root:
#   python -m unittest tests.redtest_zillow_completeness -v

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import pandas as pd

from bot import build_map_data
from bot.collectors import zillow
from bot.collectors import zillow_extras as zx
from bot.common import RAW_DIR, WEB_DATA_DIR

# zillow published all twelve months of 2024
MONTHS_2024 = [
    "2024-01-31", "2024-02-29", "2024-03-31", "2024-04-30", "2024-05-31", "2024-06-30",
    "2024-07-31", "2024-08-31", "2024-09-30", "2024-10-31", "2024-11-30", "2024-12-31",
]
HEADER = "RegionID,SizeRank,RegionName,RegionType,StateName," + ",".join(MONTHS_2024) + "\n"


# one csv line, the values landing on the last months of the year and the
# months before them left blank
def line(region_id, name, region_type, state, values):
    cells = [""] * (len(MONTHS_2024) - len(values)) + [str(v) for v in values]
    return f'{region_id},1,"{name}",{region_type},{state},' + ",".join(cells) + "\n"


# a full year, a year at the three quarter boundary, and the three month counts
# the shipped cells were measured at: 429 over 7, 475 over 8, 424 over 7
MONTHLY = (
    HEADER
    + line("102001", "United States", "country", "", [60] * 12)
    + line("394299", "Abilene, TX", "msa", "TX", [60] * 12)
    + line("394320", "Akron, OH", "msa", "OH", [60] * 9)
    + line("394351", "Albany, GA", "msa", "GA", [57, 58, 59, 61, 64, 65, 65])
    + line("394800", "Williamsport, PA", "msa", "PA", [57, 58, 59, 60, 60, 60, 61, 60])
    + line("394500", "Coeur d'Alene, ID", "msa", "ID", [59, 60, 60, 60, 61, 62, 62])
)

FORECAST = (
    "RegionID,SizeRank,RegionName,RegionType,StateName,BaseDate,2026-08-31,2027-07-31\n"
    '394299,1,"Abilene, TX",msa,TX,2026-07-31,0.6,2.3\n'
)

NAMES = {
    "10180": "Abilene, TX",
    "10420": "Akron, OH",
    "10500": "Albany, GA",
    "48700": "Williamsport, PA",
    "17660": "Coeur d'Alene, ID",
}

GAZETTEER = pd.DataFrame({
    "cbsa_code": list(NAMES),
    "name": [f"{name} Metro Area" for name in NAMES.values()],
    "cbsa_type": [1] * len(NAMES),
    "parent_cbsa": [""] * len(NAMES),
})

HTML = b"<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head><body>gone</body></html>\n"

# stand-ins for the archive when the collectors have not been run on this
# checkout. data/raw/zillow/*.csv is gitignored, so it is often absent
CANNED_WIDE = (HEADER + line("394299", "Abilene, TX", "msa", "TX", [60] * 12)).encode()
CANNED_METRICS = (
    "cbsa_code,metric,period,value\n"
    "10180,days_to_pending,2024,60.0\n"
    "10180,inventory,2024,60.0\n"
    "10180,price_cut_share,2024,0.2\n"
    "10180,zhvf_forecast,2026-07,2.3\n"
).encode()


def cells(df, code, metric):
    out = df[(df.cbsa_code == code) & (df.metric == metric)]
    return dict(zip(out.period, out.value))


# the archive a run would be replacing, copied into a temp folder so no
# collector under test can reach the real one
def seed(dest, source, fallback):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if source.exists():
        shutil.copy2(source, dest)
    else:
        dest.write_bytes(fallback)
    return dest


# an annual mean needs at least three quarters of the months the source
# published for that year, or it is withheld. build_map_data.zillow_annual
# applies that rule, and it has to hold wherever an annual mean is formed
class TestAnnualMeanNeedsEnoughOfTheYear(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.centroids = self.root / "cbsa_centroids.csv"
        GAZETTEER.to_csv(self.centroids, index=False)
        self.out_dir = self.root / "zillow_extras"
        self.bodies = {
            zx.FILES["inventory"][0]: MONTHLY.encode(),
            zx.FILES["days_to_pending"][0]: MONTHLY.encode(),
            zx.FILES["price_cut_share"][0]: MONTHLY.encode(),
            zx.FILES["zhvf_forecast"][0]: FORECAST.encode(),
        }
        with patch.object(zx, "fetch", side_effect=lambda url, **kw: Mock(status_code=200, content=self.bodies[url])), \
                patch.object(zx, "CENTROIDS", self.centroids), \
                patch.object(zx, "OUT_DIR", self.out_dir), \
                patch.object(zx, "OUT_FILE", self.out_dir / "metrics.csv"):
            self.metrics = pd.read_csv(zx.collect(), dtype={"cbsa_code": str, "period": str})

    def tearDown(self):
        self.tmp.cleanup()

    def published(self, code):
        return cells(self.metrics, code, "days_to_pending")

    def test_twelve_of_twelve_months_is_a_year(self):
        self.assertEqual(self.published("10180")["2024"], 60.0)

    def test_nine_of_twelve_months_is_a_year(self):
        self.assertEqual(self.published("10420")["2024"], 60.0)

    def test_eight_of_twelve_months_is_not_a_year(self):
        self.assertNotIn("2024", self.published("48700"),
                         "8 of 12 published months is not an annual mean")

    def test_seven_of_twelve_months_is_not_a_year(self):
        self.assertNotIn("2024", self.published("10500"),
                         "7 of 12 published months is not an annual mean")
        self.assertNotIn("2024", self.published("17660"),
                         "7 of 12 published months is not an annual mean")

    # the same file read through the map builder's door. one rule, one answer
    def test_the_builder_and_the_collector_read_the_same_year_alike(self):
        frame = zx.load_frame(MONTHLY.encode())
        builder, collector = {}, {}
        for code, name in NAMES.items():
            builder[name] = build_map_data.rnd(
                build_map_data.zillow_annual(build_map_data.match_zillow(name, frame), 2024), 4)
            collector[name] = self.published(code).get("2024")
        self.assertEqual(collector, builder)


# a bad download does not overwrite the archive it is replacing
class TestABadDownloadKeepsTheArchive(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.centroids = self.root / "cbsa_centroids.csv"
        GAZETTEER.to_csv(self.centroids, index=False)
        self.extras_dir = self.root / "zillow_extras"
        self.zillow_dir = self.root / "zillow"

    def tearDown(self):
        self.tmp.cleanup()

    # three of the four files 404 and the forecast answers for one metro
    def test_a_partial_extras_fetch_keeps_the_complete_metrics_file(self):
        path = seed(self.extras_dir / "metrics.csv", RAW_DIR / "zillow_extras" / "metrics.csv", CANNED_METRICS)
        before = pd.read_csv(path, dtype={"cbsa_code": str, "period": str})
        bodies = {zx.FILES["zhvf_forecast"][0]: FORECAST.encode()}

        def fetch(url, **kwargs):
            if url not in bodies:
                return Mock(status_code=404, content=b"not found")
            return Mock(status_code=200, content=bodies[url])

        with patch.object(zx, "fetch", side_effect=fetch), \
                patch.object(zx, "CENTROIDS", self.centroids), \
                patch.object(zx, "OUT_DIR", self.extras_dir), \
                patch.object(zx, "OUT_FILE", path):
            self.assertTrue(str(zx.OUT_FILE).startswith(str(self.root)))
            # a collector that refuses loudly is fine too, replacing is not
            try:
                zx.collect()
            except RuntimeError:
                pass

        after = pd.read_csv(path, dtype={"cbsa_code": str, "period": str})
        self.assertEqual((len(after), sorted(set(after.metric))),
                         (len(before), sorted(set(before.metric))))

    # a 200 carrying an html error page
    def test_an_html_body_keeps_the_downloaded_csvs(self):
        for filename in zillow.FILES:
            seed(self.zillow_dir / filename, RAW_DIR / "zillow" / filename, CANNED_WIDE)
        before = self.archive()

        with patch.object(zillow, "fetch", return_value=Mock(status_code=200, content=HTML)), \
                patch.object(zillow, "OUT_DIR", self.zillow_dir):
            self.assertTrue(str(zillow.OUT_DIR).startswith(str(self.root)))
            try:
                zillow.collect()
            except RuntimeError:
                pass

        self.assertEqual(self.archive(), before)

    # size in bytes and whether the body is still a zillow csv, per file
    def archive(self):
        state = {}
        for filename in zillow.FILES:
            content = (self.zillow_dir / filename).read_bytes()
            state[filename] = (len(content), zx.looks_like_csv(content))
        return state


# zillow files lexington park md under its former principal city, california
# md, and publishes 320 months of zhvi and 140 of zori for it
class TestLexingtonParkKeepsItsZillowHistory(unittest.TestCase):
    CODE = "30500"
    NAME = "Lexington Park, MD"
    ZILLOW_NAME = "California, MD"
    FIELDS = ("zhvi", "zori", "days_to_pending", "inventory", "price_cut_share", "zhvf_forecast")

    def test_the_builder_finds_the_former_city_name(self):
        frame = zx.load_frame((HEADER + line("394512", self.ZILLOW_NAME, "msa", "MD", [435182.85] * 12)).encode())
        row = build_map_data.match_zillow(self.NAME, frame)
        self.assertEqual(build_map_data.rnd(build_map_data.zillow_annual(row, 2024), 2), 435182.85)

    def test_the_collector_maps_the_former_city_name_to_the_cbsa_code(self):
        self.assertEqual(zx.match_names([(self.CODE, self.NAME)], [self.ZILLOW_NAME]),
                         {self.ZILLOW_NAME: self.CODE})

    def test_the_shipped_map_is_not_blank_for_it(self):
        payload = json.loads((WEB_DATA_DIR / "metros.json").read_text())
        metro = next(m for m in payload["metros"] if m["cbsa"] == self.CODE)
        blank = sorted(field for field in self.FIELDS if metro["latest"][field] is None)
        self.assertEqual(blank, [])


if __name__ == "__main__":
    unittest.main()

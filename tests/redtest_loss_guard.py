# a red test.
# run_tests.py discovers test*.py, so this one runs on its own, from the root:
#   ml/.venv/bin/python -m unittest tests.redtest_loss_guard -v

import json
import unittest
from pathlib import Path

import pandas as pd

from bot import build_map_data as bm
from bot import indicators
from tests.test_build_map_data import BuildCase, fhfa_fixture, national_rows

# the bls file a keyed pull writes: an annual average (M13) for every study year
# and the newest month. keyless, bot/collectors/bls.py pulls the newest ten year
# window only, which from 2026 is 2017 onward, so the 2014 averages go and the
# newest month stays
KEYED_BLS = pd.DataFrame(
    [(f"LAUMT{code}00000003", code, year, period, value)
     for code, values in (("10180", (4.1, 3.5, 3.4, 3.7)),
                          ("16980", (7.9, 4.0, 5.2, 5.6)),
                          ("44100", (5.6, 3.9, 4.4, 4.6)))
     for (year, period), value in zip(((2014, "M13"), (2019, "M13"), (2024, "M13"), (2025, "M03")), values)],
    columns=["series_id", "cbsa_code", "year", "period", "value"],
)
KEYLESS_FIRST_YEAR = 2017
UNEMP_2014 = {"10180": 4.1, "16980": 7.9, "44100": 5.6}


# the fixtures next door, laid out the way data/raw is: one folder per
# collector, each carrying the manifest that names its version beside the file
# the build reads out of it (the same layout tests/redtest_build_map_guards.py
# uses)
class LossCase(BuildCase):
    def setUp(self):
        super().setUp()
        self.paths["fhfa"] = self.collector("fhfa", "hpi_master.csv", "2026-Q2")
        fhfa_fixture().to_csv(self.paths["fhfa"], index=False)
        self.paths["national"] = self.collector("national", "indicators.csv", "through 2026-08-01")
        self.paths["national"].write_text(national_rows())
        self.paths["bls"] = self.collector("bls", "laus_metro_unemployment.csv", "1990 onward")
        KEYED_BLS.to_csv(self.paths["bls"], index=False)
        self.out = Path(self.tmp.name) / "metros.json"

    def collector(self, name, filename, version):
        folder = Path(self.tmp.name) / name
        folder.mkdir(exist_ok=True)
        (folder / bm.MANIFEST_FILE).write_text(json.dumps([{
            "filename": filename,
            "source": {"url": f"https://example.org/{name}/{filename}", "provider": name},
            "integrity": {"sha256": "abc123", "row_count": 1},
            "version": version,
            "downloaded_at": "2026-09-16T00:00:00Z",
        }]))
        return folder / filename

    # the refusal's message, or none when the rebuild went through
    def rebuild(self):
        try:
            bm.build(out_path=self.out, paths=dict(self.paths))
        except RuntimeError as error:
            return str(error)
        return None

    def on_disk(self):
        return json.loads(self.out.read_text())


# payload_counts measures the metros, the tiles and each metro's latest
# fields. the year panels are never counted, so a rebuild that blanks a whole
# field-year while the newest month survives passes the guard untouched
class TestTheGuardCountsTheYearPanels(LossCase):
    def unemp_2014(self, payload):
        return {m["cbsa"]: m["years"]["2014"]["unemp"] for m in payload["metros"]}

    def test_a_keyless_bls_pull_cannot_blank_every_2014_unemployment_rate(self):
        self.assertEqual(self.unemp_2014(self.build_to(self.out)), UNEMP_2014)
        before = self.out.read_bytes()

        KEYED_BLS[KEYED_BLS["year"] >= KEYLESS_FIRST_YEAR].to_csv(self.paths["bls"], index=False)
        refused = self.rebuild()

        # the file on disk is the map the site serves, so it keeps the column
        self.assertEqual(self.unemp_2014(self.on_disk()), UNEMP_2014,
                         "the rebuild wrote a null over every metro's 2014 unemployment rate")
        self.assertEqual(self.out.read_bytes(), before)
        self.assertIsNotNone(refused, "the rebuild blanked a year panel column instead of refusing")
        self.assertIn("bls", refused)

    # and the newest month alone still counts as the source being there
    def test_the_newest_month_survives_the_keyless_pull(self):
        self.build_to(self.out)
        KEYED_BLS[KEYED_BLS["year"] >= KEYLESS_FIRST_YEAR].to_csv(self.paths["bls"], index=False)
        payload = json.loads(bm.build(out_path=Path(self.tmp.name) / "fresh.json", paths=dict(self.paths)).read_text())
        self.assertEqual(self.metro(payload, "10180")["latest"]["unemp"], 3.7)


# the strip is counted as one number, thirteen tiles, and the refusal fires
# only when a count reaches zero. national.collect skips a series fred answers
# with no observations and writes the rest, so one tile can vanish from the
# daily national refresh with nothing but a print line to say so
class TestTheGuardCountsEachTileByName(LossCase):
    def tiles(self, payload):
        return [tile["id"] for tile in payload["national"]["indicators"]]

    def test_a_series_fred_answered_with_nothing_cannot_drop_its_tile(self):
        self.assertEqual(self.tiles(self.build_to(self.out)), [spec["id"] for spec in indicators.INDICATORS])
        before = self.out.read_bytes()

        rows = [line for line in national_rows().splitlines() if not line.startswith("CPIAUCSL,")]
        self.paths["national"].write_text("\n".join(rows) + "\n")
        refused = self.rebuild()

        self.assertIn("cpi", self.tiles(self.on_disk()), "the rebuild dropped the cpi tile the map carried")
        self.assertEqual(self.out.read_bytes(), before)
        self.assertIsNotNone(refused, "the rebuild lost a tile instead of refusing")
        self.assertTrue("national" in refused or "cpi" in refused, refused)

    # the control: a rebuild that can still make every tile is written
    def test_a_rebuild_with_every_series_keeps_all_thirteen(self):
        self.build_to(self.out)
        self.assertIsNone(self.rebuild())
        self.assertEqual(len(self.tiles(self.on_disk())), len(indicators.INDICATORS))


# the metros are counted as one number too. a rebuild that reads no centroid at
# all is refused (tests/redtest_build_map_guards.py), and one that reads a
# single centroid keeps one metro, a count that never reaches zero, and is
# written. on the shipped inputs that is 410 metros down to 2
class TestTheGuardCountsTheMetros(LossCase):
    def codes(self, payload):
        return sorted(m["cbsa"] for m in payload["metros"])

    def test_a_rebuild_that_keeps_one_metro_of_three_refuses_to_write(self):
        self.assertEqual(self.codes(self.build_to(self.out)), ["10180", "16980", "44100"])
        before = self.out.read_bytes()

        centroids = pd.read_csv(self.paths["centroids"], dtype={"cbsa_code": str})
        centroids[centroids["cbsa_code"] == "10180"].to_csv(self.paths["centroids"], index=False)
        refused = self.rebuild()

        self.assertEqual(self.codes(self.on_disk()), ["10180", "16980", "44100"],
                         "the rebuild took two of the three metros off the map")
        self.assertEqual(self.out.read_bytes(), before)
        self.assertIsNotNone(refused, "the rebuild lost two metros instead of refusing")


if __name__ == "__main__":
    unittest.main()

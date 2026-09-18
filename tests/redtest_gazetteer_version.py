# a red test. run_tests.py discovers test*.py, so this one runs on its own:
#   ml/.venv/bin/python -m unittest tests.redtest_gazetteer_version -v

import unittest
from pathlib import Path

from bot import build_map_data as bm
from tests.test_build_map_data import BuildCase


# every other line in the sources block is read off something this build loaded.
# fhfa and national go to null when it loaded nothing, which is what lets
# refuse_to_lose_a_source tell a real vintage from a borrowed one. gazetteer is
# a constant in the module, so it names the folder whatever the build opened,
# and the folder holds three files the build reads: the centroids every dot is
# placed at, and the two frozen vintage tables behind the decade growth rates
class TestTheGazetteerLineIsEvidenceOfARead(BuildCase):
    def absent(self, name):
        return Path(self.tmp.name) / f"absent_{name}.csv"

    def without_the_vintage_tables(self):
        return self.build(membership=self.absent("membership"),
                          county_population=self.absent("population"))

    # the build says so on the way past: "cbsa county membership by vintage not
    # found, its fields will be null". the sources line says nothing
    def test_a_build_that_opened_neither_vintage_table_still_claims_the_folder(self):
        whole = self.build()["sources"]["gazetteer"]
        self.assertEqual(whole, f"{bm.GAZETTEER_YEAR} Gazetteer")
        self.assertNotEqual(self.without_the_vintage_tables()["sources"]["gazetteer"], whole,
                            "one vintage line over a build that opened one of the folder's three files")

    # and the folder stays named either way, because the vintage line and the
    # provenance block are two readings of one list of folders
    def test_the_folder_is_still_named_either_way(self):
        self.assertIn("gazetteer", self.without_the_vintage_tables()["sources"])


# what the line is covering for. without the tables the redraw test falls back
# to the state list in the acs name, which the module's own comment measures at
# 13 of the 84 metros whose county set moved between the 2014 and 2024 vintages
class TestWhatTheVintageTablesDecide(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.merged = bm.load_merged(bm.DEFAULT_PATHS["merged"])
        cls.centroids = bm.load_centroids(bm.DEFAULT_PATHS["centroids"])
        cls.membership = bm.load_membership(bm.DEFAULT_PATHS["membership"])

    def rates(self, membership):
        metros, _, _ = bm.build_metros(self.merged, self.centroids, membership=membership)
        return {m["cbsa"]: m["growth"]["pop_14_24"] for m in metros}

    # bend-redmond went from one county to three, which is the example the
    # footprint comment names
    def test_a_redrawn_metro_publishes_a_decade_rate_when_the_table_is_absent(self):
        self.assertIsNone(self.rates(self.membership)["13460"])
        self.assertEqual(self.rates(None)["13460"], 0.5803)

    def test_seventy_two_metros_gain_a_rate_the_delineation_refuses(self):
        held, guessed = self.rates(self.membership), self.rates(None)
        gained = sorted(c for c in held if held[c] is None and guessed[c] is not None)
        self.assertEqual(len(gained), 72, gained[:8])


if __name__ == "__main__":
    unittest.main()

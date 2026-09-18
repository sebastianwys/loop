# a red test. run_tests.py discovers test*.py, so this one runs on its own:
#   ml/.venv/bin/python -m unittest tests.redtest_hud_subarea -v

import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import pandas as pd

from bot.collectors import hud

# the fixture is synthetic, built from the response shapes in the hud user api
# documentation, and carries the figures of two virginia metros so the value a
# cbsa should publish can be read off the arithmetic rather than taken on trust

TOKEN = "synthetic-token-1234"
YEAR = 2027

BLACKSBURG = "Blacksburg-Christiansburg-Radford, VA HUD Metro FMR Area"
CHARLOTTESVILLE = "Charlottesville, VA MSA"

# hud lists a whole metro entity for both codes. blacksburg's is an exception
# area: hud publishes it for montgomery county and radford city alone, while the
# delineation gives that cbsa five counties sitting in four fmr areas. the
# charlottesville entity covers every county its cbsa has
LISTING = {"data": [
    {"cbsa_code": "METRO13980M13980", "area_name": BLACKSBURG, "category": "MetroArea"},
    {"cbsa_code": "METRO16820M16820", "area_name": CHARLOTTESVILLE, "category": "MetroArea"},
]}

# what each entity answers with, and the counties hud says it stands for
ENTITY_RENT = {"METRO13980M13980": 1340, "METRO16820M16820": 1642}
ENTITY_COUNTIES = {
    "METRO13980M13980": "Montgomery County, VA; Radford city, VA",
    "METRO16820M16820": ("Albemarle County, VA; Charlottesville city, VA; Fluvanna County, VA; "
                         "Greene County, VA; and Nelson County, VA"),
}

MERGED = (
    "cbsa_code,place_name,geo_level,parent_cbsa,year\n"
    "13980,\"Blacksburg-Christiansburg-Radford, VA\",msa,,2024\n"
    "16820,\"Charlottesville, VA\",msa,,2024\n"
)

# the omb delineation as the gazetteer collector writes it, five counties each
MEMBERSHIP = (
    "cbsa_code,county_fips\n"
    "13980,51063\n"
    "13980,51071\n"
    "13980,51121\n"
    "13980,51155\n"
    "13980,51750\n"
    "16820,51003\n"
    "16820,51065\n"
    "16820,51079\n"
    "16820,51125\n"
    "16820,51540\n"
)

STATE_LIST = [{"state_name": "Virginia", "state_code": "VA", "state_num": "51.0", "category": "State"}]

# every county of the two metros, the fmr area hud's statedata endpoint puts it
# in and that area's two bedroom rent. only montgomery county and radford city
# carry the rent the blacksburg entity publishes
COUNTY_ROWS = {
    "5106399999": ("Floyd County, VA HUD Metro FMR Area", 1090),
    "5107199999": ("Giles County, VA HUD Metro FMR Area", 999),
    "5112199999": (BLACKSBURG, 1340),
    "5115599999": ("Pulaski County, VA HUD Metro FMR Area", 952),
    "5175099999": (BLACKSBURG, 1340),
    "5100399999": (CHARLOTTESVILLE, 1642),
    "5106599999": (CHARLOTTESVILLE, 1642),
    "5107999999": (CHARLOTTESVILLE, 1642),
    "5112599999": (CHARLOTTESVILLE, 1642),
    "5154099999": (CHARLOTTESVILLE, 1642),
}

# acs population, the weight a county carries in a rollup
COUNTY_POPULATION = {
    "51063": 15593, "51071": 16557, "51121": 99101, "51155": 33687, "51750": 16726,
    "51003": 114919, "51065": 28092, "51079": 21155, "51125": 14732, "51540": 45437,
}

# the two counties hud's blacksburg entity covers hold 115,827 of the metro's
# 181,664 people, so the entity's 1340 is a value for two thirds of it. over
# all five counties:
# (1090*15593 + 999*16557 + 1340*(99101 + 16726) + 952*33687) / 181664 = 1215.51
BLACKSBURG_WEIGHTED = 1216.0


def response(status, payload=None):
    r = Mock(status_code=status)
    r.json = Mock(return_value=payload)
    return r


def fmr_payload(year, rent, entity):
    name = LISTING["data"][0]["area_name"] if entity.startswith("METRO13980") else CHARLOTTESVILLE
    return {"data": {
        "county_name": "", "counties_msa": ENTITY_COUNTIES[entity], "town_name": "",
        "metro_status": "1", "metro_name": name, "area_name": name,
        "smallarea_status": "0", "year": str(year),
        "basicdata": {"Efficiency": "700.0", "One-Bedroom": "750.0", "Two-Bedroom": f"{rent}.0",
                      "Three-Bedroom": "1000.0", "Four-Bedroom": "1200.0", "year": str(year)},
    }}


def county_row(fips, area, rent):
    return {"fips_code": fips, "county_name": "", "town_name": "", "metro_name": area,
            "Efficiency": rent - 300, "One-Bedroom": rent - 150, "Two-Bedroom": rent,
            "Three-Bedroom": rent + 400, "Four-Bedroom": rent + 700, "smallarea_status": "0"}


def fake_census(url, params=None, **kwargs):
    if (params or {}).get("for") == "county:*":
        rows = [[str(pop), fips[:2], fips[2:]] for fips, pop in sorted(COUNTY_POPULATION.items())]
        return response(200, [["B01003_001E", "state", "county"]] + rows)
    return response(200, [["B01003_001E", "state", "county", "county subdivision"]])


# a value published for a cbsa has to cover that cbsa's whole county set. the
# collector already applies that rule to the codes hud has no entity for, an acs
# population weighted mean over the fmr areas the counties sit in
class TestWholeMetroCoverage(unittest.TestCase):
    def fake_get(self, url, params=None, timeout=None, headers=None):
        if url == hud.LIST_URL:
            return response(200, LISTING)
        if url == hud.STATE_LIST_URL:
            return response(200, STATE_LIST)
        if url == hud.STATE_URL + "VA":
            rows = [county_row(fips, area, rent) for fips, (area, rent) in sorted(COUNTY_ROWS.items())]
            return response(200, {"data": {"year": str((params or {}).get("year", YEAR)), "counties": rows}})
        if url.startswith(hud.FMR_URL):
            entity = url[len(hud.FMR_URL):]
            year = params["year"] if params and "year" in params else YEAR
            if entity in ENTITY_RENT and year == YEAR:
                return response(200, fmr_payload(year, ENTITY_RENT[entity], entity))
        return response(404, {"error": "no data"})

    def run_collect(self):
        with tempfile.TemporaryDirectory() as tmp:
            merged = Path(tmp) / "merged.csv"
            merged.write_text(MERGED)
            counties = Path(tmp) / "cbsa_counties.csv"
            counties.write_text(MEMBERSHIP)
            out_dir = Path(tmp) / "hud"
            with patch.dict(os.environ, {"HUD_API_TOKEN": TOKEN}), \
                    patch.object(hud, "INTEGRATED", merged), \
                    patch.object(hud, "OUT_DIR", out_dir), \
                    patch.object(hud, "OUT_FILE", out_dir / "metrics.csv"), \
                    patch.object(hud, "MEMBERSHIP", counties), \
                    patch("bot.collectors.hud.fetch", side_effect=fake_census), \
                    patch("bot.collectors.hud.requests.get", side_effect=self.fake_get), \
                    patch("bot.collectors.hud.time.sleep"), \
                    contextlib.redirect_stdout(io.StringIO()):
                hud.collect()
            return pd.read_csv(out_dir / "metrics.csv", dtype={"cbsa_code": str, "period": str})

    def rents(self, frame, code):
        rows = frame[(frame.cbsa_code == code) & (frame.metric == "fmr_2br")]
        return dict(zip(rows["period"], rows["value"]))

    # hud splits this metro into four fmr areas and keys the largest of them by
    # the whole metro id. the cbsa is still all five counties
    def test_a_metro_split_across_fmr_areas_is_weighted_over_all_its_counties(self):
        frame = self.run_collect()
        self.assertEqual(self.rents(frame, "13980"), {str(YEAR): BLACKSBURG_WEIGHTED},
                         "the cbsa carries hud's rent for two of its five counties")

    # and the rule leaves a metro hud publishes whole exactly as hud sent it
    def test_a_metro_whose_entity_covers_every_county_keeps_hud_s_own_value(self):
        frame = self.run_collect()
        self.assertEqual(self.rents(frame, "16820"), {str(YEAR): 1642.0})


if __name__ == "__main__":
    unittest.main()

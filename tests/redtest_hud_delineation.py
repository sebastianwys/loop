# a red test. run_tests.py discovers test*.py, so this one runs on its own:
#   ml/.venv/bin/python -m unittest tests.redtest_hud_delineation -v

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
# documentation, and carries two new jersey metros so the value a cbsa should
# publish can be read off the arithmetic rather than taken on trust
#
# hud trails the omb delineation by a year or more on a handful of codes. the
# entity is named "..., ST MSA" like any whole metro, so the name rule that
# catches an exception area cannot see it, and it still covers the metro as it
# was drawn before the change. only the counties say so

TOKEN = "synthetic-token-1234"
YEAR = 2024
CAUGHT_UP = 2027

ATLANTIC_CITY = "Atlantic City-Hammonton, NJ MSA"
OCEAN_CITY = "Ocean City, NJ MSA"
TRENTON = "Trenton-Princeton, NJ MSA"

LISTING = {"data": [
    {"cbsa_code": "METRO12100M12100", "area_name": ATLANTIC_CITY, "category": "MetroArea"},
    {"cbsa_code": "METRO45940M45940", "area_name": TRENTON, "category": "MetroArea"},
]}

# what each entity answers with per year. hud publishes the atlantic city
# entity for atlantic county alone in 2024 and for both counties in 2027
ENTITY_RENT = {
    ("METRO12100M12100", YEAR): 1670,
    ("METRO12100M12100", CAUGHT_UP): 1810,
    ("METRO45940M45940", YEAR): 1750,
    ("METRO45940M45940", CAUGHT_UP): 1890,
}

MERGED = (
    "cbsa_code,place_name,geo_level,parent_cbsa,year\n"
    "12100,\"Atlantic City-Hammonton, NJ\",msa,,2024\n"
    "45940,\"Trenton-Princeton, NJ\",msa,,2024\n"
)

# the omb delineation as the gazetteer collector writes it. the 2023 revision
# gives 12100 cape may county as well as atlantic
MEMBERSHIP = (
    "cbsa_code,county_fips\n"
    "12100,34001\n"
    "12100,34009\n"
    "45940,34021\n"
)

STATE_LIST = [{"state_name": "New Jersey", "state_code": "NJ", "state_num": "34.0", "category": "State"}]

# every county of the two metros and the fmr area hud puts it in. in 2024 cape
# may is still its own area, so the atlantic city entity's 1670 is a rent for
# part of the cbsa. by 2027 hud has caught up and both counties sit in one area
COUNTY_ROWS = {
    YEAR: {
        "3400199999": (ATLANTIC_CITY, 1670),
        "3400999999": (OCEAN_CITY, 1560),
        "3402199999": (TRENTON, 1750),
    },
    CAUGHT_UP: {
        "3400199999": (ATLANTIC_CITY, 1810),
        "3400999999": (ATLANTIC_CITY, 1810),
        "3402199999": (TRENTON, 1890),
    },
}

# acs population, the weight a county carries in a rollup
COUNTY_POPULATION = {"34001": 274534, "34009": 95263, "34021": 385234}

# atlantic county holds 274,534 of the cbsa's 369,797 people and cape may the
# rest, so over the whole cbsa:
# (1670*274534 + 1560*95263) / 369797 = 1641.66
ATLANTIC_CITY_WEIGHTED = 1642.0


def response(status, payload=None):
    r = Mock(status_code=status)
    r.json = Mock(return_value=payload)
    return r


def fmr_payload(year, rent, name, counties):
    return {"data": {
        "county_name": "", "counties_msa": counties, "town_name": "",
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


# a value published for a cbsa has to cover that cbsa's counties. the collector
# applies that rule to an exception area, which says so in its name, and to the
# codes hud has no entity for. an entity that trails the delineation says
# nothing in its name and is trusted whole
class TestEntityTrailingTheDelineation(unittest.TestCase):
    def fake_get(self, url, params=None, timeout=None, headers=None):
        if url == hud.LIST_URL:
            return response(200, LISTING)
        if url == hud.STATE_LIST_URL:
            return response(200, STATE_LIST)
        if url == hud.STATE_URL + "NJ":
            year = (params or {}).get("year")
            rows = COUNTY_ROWS.get(year)
            if not rows:
                return response(404, {"error": "no data"})
            return response(200, {"data": {"year": str(year),
                                           "counties": [county_row(f, a, r) for f, (a, r) in sorted(rows.items())]}})
        if url.startswith(hud.FMR_URL):
            entity = url[len(hud.FMR_URL):]
            year = params["year"] if params and "year" in params else CAUGHT_UP
            rent = ENTITY_RENT.get((entity, year))
            if rent is None:
                return response(404, {"error": "no data"})
            name = ATLANTIC_CITY if entity.startswith("METRO12100") else TRENTON
            counties = ("Atlantic County, NJ; Cape May County, NJ; " if entity.startswith("METRO12100")
                        and year == CAUGHT_UP else
                        "Atlantic County, NJ; " if entity.startswith("METRO12100") else "Mercer County, NJ; ")
            return response(200, fmr_payload(year, rent, name, counties))
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

    # the cbsa is two counties in two fmr areas, and hud's entity is one of them
    def test_an_entity_that_covers_part_of_its_cbsa_is_rebuilt_from_its_counties(self):
        frame = self.run_collect()
        self.assertEqual(self.rents(frame, "12100")[str(YEAR)], ATLANTIC_CITY_WEIGHTED,
                         "the cbsa carries hud's rent for one of its two counties")

    # and the year hud catches up, its own number is the cbsa's again
    def test_the_year_hud_catches_up_the_entity_value_stands(self):
        frame = self.run_collect()
        self.assertEqual(self.rents(frame, "12100")[str(CAUGHT_UP)], 1810.0)

    # a metro hud never trailed on is untouched in either year
    def test_an_entity_that_covers_every_county_keeps_hud_s_own_value(self):
        frame = self.run_collect()
        self.assertEqual(self.rents(frame, "45940"), {str(YEAR): 1750.0, str(CAUGHT_UP): 1890.0})


if __name__ == "__main__":
    unittest.main()

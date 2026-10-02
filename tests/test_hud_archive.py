# the shipped table, data/raw/hud/metrics.csv, has to be what the collector at
# HEAD writes over the raw captures committed beside it, hud_<year>.json, with
# the network faked. two rules decide what a study code carries when hud's
# entity for it covers only part of the cbsa: an exception area is not read as
# the metro, and an entity whose delineation counties sit in more than one fmr
# area that year is rebuilt from those counties. test_hud_subarea and
# test_hud_delineation prove the code on fixtures; this one holds the shipped
# table to the code.
#
# what is not in the hud folder:
# - the metro listing. each captured entity is listed under the area name its
#   newest payload carries. for the codes compared here the name decides
#   nothing: counties that sit in one fmr area give that area's rent either
#   way, and counties in more than one are rebuilt from either way
# - the acs 2024 5 year county population hud asks the census for. the
#   gazetteer collector archived the same table, county_population_by_vintage.csv
# - new england town populations, so no code with a county in those six
#   states is compared
# - county rows for the states the old run never asked for, since it asked
#   only for the states its rollups needed. a code is compared in a year only
#   when the archive holds rows for every state its counties sit in
# only fmr_2br is compared: the income limits of the areas a rebuilt code
# newly needs were never captured. nothing here writes under data/

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from bot.collectors import hud

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
SHIPPED = RAW / "hud" / "metrics.csv"
MANIFEST = RAW / "hud" / "download_manifest.json"
POPULATION = RAW / "gazetteer" / "county_population_by_vintage.csv"
TOKEN = "synthetic-token-1234"
RENT = "fmr_2br"

# the exception area test_hud_subarea is built on. hud publishes it for
# montgomery county and radford city, two of the five counties of the cbsa
BLACKSBURG = "13980"


def captures():
    return {int(path.stem.split("_")[1]): json.loads(path.read_text())
            for path in sorted((RAW / "hud").glob("hud_*.json"))}


class Response:
    def __init__(self, status, body=None):
        self.status_code = status
        self.headers = {}
        self._body = body

    def json(self):
        return self._body


# the hud api as the archive recorded it. a request the archive has no answer
# for gets the 404 hud sends for an entity or state with no data that year
class ArchivedHud:
    def __init__(self, caps):
        self.caps = caps
        names = {}
        for year in sorted(caps):
            for dataset in ("il", "fmr"):
                for entity, payload in caps[year][dataset].items():
                    data = payload.get("data") if isinstance(payload, dict) else None
                    if entity.startswith("METRO") and isinstance(data, dict):
                        names[entity] = str(data.get("area_name", ""))
        self.listing = {"data": [{"cbsa_code": entity, "area_name": name, "category": "MetroArea"}
                                 for entity, name in sorted(names.items())]}
        self.state_fips = {}
        for year in caps:
            for postal, payload in caps[year]["states"].items():
                for row in payload["data"]["counties"]:
                    if row.get("fips_code"):
                        self.state_fips[postal] = str(row["fips_code"])[:2]
        self.state_list = [{"state_name": postal, "state_code": postal, "state_num": fips, "category": "State"}
                           for postal, fips in sorted(self.state_fips.items())]

    # the states the archive holds county rows for in a year, as fips
    def states_in(self, year):
        return {self.state_fips[postal] for postal in self.caps.get(year, {}).get("states", {})}

    def newest(self, dataset, entity):
        for year in sorted(self.caps, reverse=True):
            if entity in self.caps[year][dataset]:
                return self.caps[year][dataset][entity]
        return None

    def get(self, url, params=None, timeout=None, headers=None):
        year = (params or {}).get("year")
        payload = None
        if url == hud.LIST_URL:
            payload = self.listing
        elif url == hud.STATE_LIST_URL:
            payload = self.state_list
        elif url.startswith(hud.STATE_URL):
            payload = self.caps.get(year, {}).get("states", {}).get(url[len(hud.STATE_URL):])
        else:
            for base, dataset in ((hud.FMR_URL, "fmr"), (hud.IL_URL, "il")):
                if url.startswith(base):
                    entity = url[len(base):]
                    payload = (self.newest(dataset, entity) if year is None
                               else self.caps.get(year, {}).get(dataset, {}).get(entity))
        return Response(200, payload) if payload else Response(404, {"error": "no data"})


# the census as the gazetteer archived it: county populations, no towns
def archived_census():
    frame = pd.read_csv(POPULATION, dtype={"vintage": str, "county_fips": str})
    frame = frame[frame.vintage == str(hud.CENSUS_VINTAGE)]
    rows = [[str(value), fips[:2], fips[2:]] for fips, value in sorted(zip(frame.county_fips, frame.population))]

    def fetch(url, params=None, **kwargs):
        if (params or {}).get("for") == "county:*":
            return Response(200, [["B01003_001E", "state", "county"]] + rows)
        return Response(200, [["B01003_001E", "state", "county", "county subdivision"]])
    return fetch


# collect at HEAD over the archive, reading back the table it writes
def rerun(api):
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp) / "hud"
        with patch.dict(os.environ, {"HUD_API_TOKEN": TOKEN}), \
                patch.object(hud, "OUT_DIR", out_dir), \
                patch.object(hud, "OUT_FILE", out_dir / "metrics.csv"), \
                patch("bot.collectors.hud.fetch", side_effect=archived_census()), \
                patch("bot.collectors.hud.requests.get", side_effect=api.get), \
                patch("bot.collectors.hud.time.sleep"), \
                contextlib.redirect_stdout(io.StringIO()):
            hud.collect()
        return pd.read_csv(out_dir / "metrics.csv", dtype={"cbsa_code": str, "period": str})


def rents(frame):
    rows = frame[frame.metric == RENT]
    return {(code, period): float(value) for code, period, value in zip(rows.cbsa_code, rows.period, rows.value)}


class TestTheShippedRentsAreWhatTheCollectorWrites(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        needed = [SHIPPED, MANIFEST, POPULATION, hud.MEMBERSHIP, hud.INTEGRATED]
        absent = [path.name for path in needed if not path.exists()]
        if absent or not list((RAW / "hud").glob("hud_*.json")):
            raise unittest.SkipTest(f"not on disk: {absent or 'hud_<year>.json'}")
        api = ArchivedHud(captures())
        cls.head = rents(rerun(api))
        cls.shipped = rents(pd.read_csv(SHIPPED, dtype={"cbsa_code": str, "period": str}))
        membership = hud.load_membership(hud.MEMBERSHIP)
        years = sorted({period for _, period in cls.shipped} | {period for _, period in cls.head})
        cls.compared = sorted(
            (code, period) for code in hud.study_codes(hud.INTEGRATED) for period in years
            if membership.get(code)
            and not {fips[:2] for fips in membership[code]} & hud.NEW_ENGLAND
            and {fips[:2] for fips in membership[code]} <= api.states_in(int(period)))
        cls.rebuilt_before = set(json.loads(MANIFEST.read_text())[0]["notes"]["rollup_areas"])

    def differences(self, keys):
        return [(code, period, self.shipped.get((code, period)), self.head.get((code, period)))
                for code, period in keys if self.shipped.get((code, period)) != self.head.get((code, period))]

    def test_the_shipped_rents_equal_the_collector_run_on_its_own_raw_captures(self):
        self.assertGreater(len(self.compared), 500, "too few code-years can be decided from the archive")
        wrong = self.differences(self.compared)
        worst = sorted(wrong, key=lambda w: -abs((w[2] or 0) / (w[3] or 1) - 1))[:4]
        self.assertEqual(len(wrong), 0, f"code-years over {len({w[0] for w in wrong})} metros where the shipped "
                                        f"rent is not the one the collector computes, worst as (code, year, "
                                        f"shipped, at head): {worst}")

    # the example the subarea test is built on, in every year hud has
    def test_blacksburg_carries_the_rent_of_all_five_of_its_counties(self):
        years = sorted(period for code, period in self.compared if code == BLACKSBURG)
        self.assertTrue(years, "blacksburg cannot be decided from the archive")
        self.assertEqual({year: self.shipped.get((BLACKSBURG, year)) for year in years},
                         {year: self.head.get((BLACKSBURG, year)) for year in years})

    # the control: the codes the old run already rebuilt from their counties
    # come out the same at HEAD, so the county rows, the weights and the
    # arithmetic of this rerun are the ones the shipped table was made with
    def test_the_codes_already_rebuilt_from_counties_reproduce_exactly(self):
        keys = [(code, period) for code, period in self.compared if code in self.rebuilt_before]
        self.assertGreater(len(keys), 100)
        self.assertEqual(self.differences(keys), [])


if __name__ == "__main__":
    unittest.main()

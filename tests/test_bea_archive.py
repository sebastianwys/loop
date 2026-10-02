# the shipped bea table, data/raw/bea/metrics.csv, has to be what the
# collector writes. test_bea_connecticut proves the code on a fixture; this
# one holds the archive to the code.
#
# the raw payloads the table was rolled up from are committed beside it, so
# the collector at HEAD can be run on them with the network faked, and what
# it writes is what the shipped table has to say. the one input not in the
# bea folder is the july 2023 delineation, which collect() downloads. the
# gazetteer collector archived the same workbook as cbsa_counties.csv, one
# row per code and county, so it is served back in the workbook's shape.
# nothing here writes under data/

import copy
import io
import json
import os
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest import mock

import pandas as pd

from bot.collectors import bea

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
SHIPPED = RAW / "bea" / "metrics.csv"
MANIFEST = RAW / "bea" / "download_manifest.json"
MEMBERSHIP = RAW / "gazetteer" / "cbsa_counties.csv"
FAKE_KEY = "0000AAAA-1111-2222-3333-444455556666"

# the connecticut study metros a pre-2022 county reaches through the planning
# region that succeeded it. 47930 waterbury-shelton is naugatuck valley, which
# no county maps to, so it has no year before the regions and is left out
CONNECTICUT = {"14860": "bridgeport", "25540": "hartford", "35300": "new haven", "35980": "norwich"}
CONTROL = "10180"

HEADER = ["CBSA Code", "Metropolitan Division Code", "CSA Code", "CBSA Title",
          "Metropolitan/Micropolitan Statistical Area", "Metropolitan Division Title", "CSA Title",
          "County/County Equivalent", "State Name", "FIPS State Code", "FIPS County Code",
          "Central/Outlying County"]


def shipped():
    return pd.read_csv(SHIPPED, dtype={"cbsa_code": str, "period": str})


# every code and county pair of the delineation, a division's pairs as rows of
# their own, which is the set irs.parse_crosswalk reads out of list1_2023.xlsx
def delineation():
    pairs = pd.read_csv(MEMBERSHIP, dtype=str)
    rows = [[code, None, None, "Title", "Metropolitan Statistical Area", None, None,
             "County", "State", fips[:2], fips[2:], "Central"]
            for code, fips in zip(pairs["cbsa_code"], pairs["county_fips"])]
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        pd.DataFrame(rows, columns=HEADER).to_excel(writer, index=False, startrow=2, sheet_name="List 1")
        writer.sheets["List 1"]["A1"] = "List 1. Core based statistical areas, July 2023"
    return buffer.getvalue()


class FakeResponse:
    def __init__(self, body=None, status=200, content=b""):
        self.status_code = status
        self.ok = status < 400
        self.content = content
        self._body = body

    def json(self):
        return self._body


def not_published():
    return {"BEAAPI": {"Request": {"RequestParam": []},
                       "Error": {"APIErrorCode": bea.NOT_PUBLISHED,
                                 "APIErrorDescription": "The requested year is not available."}}}


# the calendar year of the archived run. its first request asked for every
# year from 2014 through the one before it, and the manifest keeps that list
def pulled_in():
    entries = json.loads(MANIFEST.read_text())
    requests = next(e["notes"]["year_requests"] for e in entries if e["filename"] == "cainc1_line1.json")
    return max(int(year) for year in requests[0].split(",")) + 1


# bea as the archive recorded it: a request for a line and a list of years
# answers with that line's archived rows for those years, and a year with no
# archived row answers the not published error the archived run stopped on
def answer(payload, years):
    kept = copy.deepcopy(payload)
    block = kept["BEAAPI"]["Results"]
    block["Data"] = [row for row in block["Data"] if row.get("TimePeriod") in years]
    return kept if block["Data"] else not_published()


# the delineation download carries no query parameters
def fake_fetch(archive, workbook):
    def fetch(url, params=None, **kwargs):
        if params is None:
            return FakeResponse(content=workbook)
        if params.get("LineCode") in archive:
            return FakeResponse(answer(archive[params["LineCode"]], set(str(params["Year"]).split(","))))
        return FakeResponse(not_published())
    return fetch


# collect at HEAD over the archived payloads, reading back the table it writes
def rerun():
    archive = {line: json.loads((RAW / "bea" / f"cainc1_line{line}.json").read_text()) for line in bea.LINES}
    year = pulled_in()
    with ExitStack() as stack:
        out_dir = Path(stack.enter_context(tempfile.TemporaryDirectory())) / "bea"
        stack.enter_context(mock.patch.dict(os.environ, {"BEA_API_KEY": FAKE_KEY}))
        stack.enter_context(mock.patch.object(bea, "OUT_DIR", out_dir))
        stack.enter_context(mock.patch.object(bea, "PAUSE_SECONDS", 0))
        stack.enter_context(mock.patch.object(bea, "this_year", lambda: year))
        stack.enter_context(mock.patch.object(bea, "fetch", fake_fetch(archive, delineation())))
        with redirect_stdout(io.StringIO()):
            bea.collect()
        return pd.read_csv(out_dir / "metrics.csv", dtype={"cbsa_code": str, "period": str})


def keyed(frame):
    return {(c, m, p): int(v) for c, m, p, v in zip(frame.cbsa_code, frame.metric, frame.period, frame.value)}


def periods_of(frame, code, metric=bea.PER_CAPITA):
    return sorted(frame[(frame.cbsa_code == code) & (frame.metric == metric)].period.unique())


class TestTheShippedBeaTableIsWhatTheCollectorWrites(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        needed = [SHIPPED, MANIFEST, MEMBERSHIP] + [RAW / "bea" / f"cainc1_line{line}.json" for line in bea.LINES]
        absent = [path.name for path in needed if not path.exists()]
        if absent:
            raise unittest.SkipTest(f"not on disk: {absent}")
        cls.head = rerun()
        cls.shipped = shipped()

    # every row, both ways, and every value
    def test_the_shipped_table_equals_the_collector_run_on_its_own_raw_payloads(self):
        head, disk = keyed(self.head), keyed(self.shipped)
        missing = sorted(set(head) - set(disk))
        extra = sorted(set(disk) - set(head))
        changed = sorted(key for key in set(head) & set(disk) if head[key] != disk[key])
        detail = (f"missing from the shipped table: codes {sorted({c for c, _, _ in missing})}, "
                  f"periods {sorted({p for _, _, p in missing})}; only in the shipped table: {extra[:5]}; "
                  f"values that differ: {changed[:5]}")
        self.assertEqual({"missing": len(missing), "extra": len(extra), "changed": len(changed)},
                         {"missing": 0, "extra": 0, "changed": 0}, detail)

    # the control: a metro whose counties never changed code carries every
    # year bea published, in the shipped table and in the rerun alike
    def test_abilene_carries_every_published_year(self):
        self.assertEqual(periods_of(self.shipped, CONTROL), periods_of(self.head, CONTROL))
        self.assertGreaterEqual(len(periods_of(self.shipped, CONTROL)), 10)

    # bea published the connecticut counties through 2023 and the planning
    # regions from 2024, the same ground, so each of these metros carries
    # the run of years abilene carries
    def test_the_connecticut_metros_carry_every_year_bea_published(self):
        years = periods_of(self.shipped, CONTROL)
        short = {code: periods_of(self.shipped, code) for code in CONNECTICUT
                 if periods_of(self.shipped, code) != years}
        self.assertEqual(short, {}, f"against abilene's {years[0]} to {years[-1]}")


if __name__ == "__main__":
    unittest.main()

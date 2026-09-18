# run from the project root:
#   ml/.venv/bin/python -m unittest tests.redtest_bea_connecticut -v

import io
import os
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest import mock

import pandas as pd

from bot.collectors import bea, irs

# every payload here is synthetic, invented numbers in the documented shape of
# a BEAAPI response. what is copied from the source is the geography, not the
# values: connecticut replaced counties with planning regions, so bea
# publishes CT COUNTY estimates through 2023 and PLANNING REGION estimates
# from 2024, and writes 0 for whichever side it did not estimate that year.
# no test here opens the network
FAKE_KEY = "0000AAAA-1111-2222-3333-444455556666"
THIS_YEAR = 2026
BULK = bea.year_param(bea.bulk_years(THIS_YEAR))
PERIODS = ["2014", "2019", "2023", "2024"]
NAMES = {"09003": "Hartford, CT", "09110": "Capitol, CT", "48441": "Taylor, TX", "48059": "Callahan, TX"}

# (county, year) -> (personal income in thousands, population). hartford
# county 09003 through 2023 and the capitol planning region 09110 from 2024
# are the same ground and both belong to hartford 25540. taylor and callahan
# are abilene 10180 and neither ever changed code
VALUES = {
    ("09003", "2014"): ("60,500,000", "1,210,000"),
    ("09003", "2019"): ("72,000,000", "1,200,000"),
    ("09003", "2023"): ("82,600,000", "1,180,000"),
    ("09003", "2024"): ("0", "0"),
    ("09110", "2014"): ("0", "0"),
    ("09110", "2019"): ("0", "0"),
    ("09110", "2023"): ("0", "0"),
    ("09110", "2024"): ("93,600,000", "1,170,000"),
    ("48441", "2014"): ("6,000,000", "140,000"),
    ("48059", "2014"): ("500,000", "13,500"),
    ("48441", "2019"): ("7,000,000", "145,000"),
    ("48059", "2019"): ("600,000", "14,000"),
    ("48441", "2023"): ("8,000,000", "148,000"),
    ("48059", "2023"): ("700,000", "14,200"),
    ("48441", "2024"): ("9,000,000", "150,000"),
    ("48059", "2024"): ("800,000", "14,500"),
}

# hand computed from the fixture
HARTFORD_INCOME_2014 = 60_500_000
HARTFORD_POPULATION_2014 = 1_210_000
HARTFORD_PER_CAPITA_2014 = 50_000
HARTFORD_PER_CAPITA_2019 = 60_000
HARTFORD_PER_CAPITA_2023 = 70_000
HARTFORD_PER_CAPITA_2024 = 80_000
ABILENE_INCOME_2014 = 6_500_000


def row(fips, period, value, line="1"):
    spec = bea.LINES[line]
    return {"Code": f"CAINC1-{line}", "GeoFips": fips, "GeoName": NAMES.get(fips, fips), "TimePeriod": period,
            "CL_UNIT": spec["unit"], "UNIT_MULT": spec["unit_mult"], "DataValue": value}


def income_rows():
    return [row(fips, period, income) for (fips, period), (income, _) in VALUES.items()]


def population_rows():
    return [row(fips, period, population, "2") for (fips, period), (_, population) in VALUES.items()]


def payload(rows, line="1", years=BULK):
    return {"BEAAPI": {
        "Request": {"RequestParam": [
            {"ParameterName": "USERID", "ParameterValue": FAKE_KEY},
            {"ParameterName": "TABLENAME", "ParameterValue": "CAINC1"},
            {"ParameterName": "LINECODE", "ParameterValue": line},
            {"ParameterName": "GEOFIPS", "ParameterValue": "COUNTY"},
            {"ParameterName": "YEAR", "ParameterValue": years},
        ]},
        "Results": {
            "Statistic": "Personal income" if line == "1" else "Population",
            "UnitOfMeasure": bea.LINES[line]["unit"],
            "UTCProductionTime": "2026-01-01T00:00:00.000",
            "Data": rows,
            "Notes": [{"NoteRef": "1", "NoteText": "synthetic fixture"}],
        },
    }}


def error_payload(code="101", description="The requested year is not available."):
    return {"BEAAPI": {
        "Request": {"RequestParam": [{"ParameterName": "USERID", "ParameterValue": FAKE_KEY}]},
        "Error": {"APIErrorCode": code, "APIErrorDescription": description},
    }}


class FakeResponse:
    def __init__(self, body=None, status=200, content=b""):
        self.status_code = status
        self.ok = status < 400
        self.content = content
        self._body = body

    def json(self):
        return self._body


HEADER = ["CBSA Code", "Metropolitan Division Code", "CSA Code", "CBSA Title",
          "Metropolitan/Micropolitan Statistical Area", "Metropolitan Division Title", "CSA Title",
          "County/County Equivalent", "State Name", "FIPS State Code", "FIPS County Code",
          "Central/Outlying County"]


# a workbook shaped like list1_2023.xlsx: two title rows, the header, county
# rows, then the note rows the census bureau appends
def workbook(rows):
    frame = pd.DataFrame(rows, columns=HEADER)
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        frame.to_excel(writer, index=False, startrow=2, sheet_name="List 1")
        writer.sheets["List 1"]["A1"] = "List 1. Core based statistical areas"
    return buffer.getvalue()


def county_row(cbsa, county, state_fips, county_fips):
    return [cbsa, None, None, "Title", "Metropolitan Statistical Area", None, None,
            county, "State", state_fips, county_fips, "Central"]


# the july 2023 delineation lists connecticut as planning regions. a
# delineation from before the change lists the counties. hartford 25540 is
# the capitol planning region in the first and hartford county in the second
CURRENT_CONNECTICUT = ("110", "Capitol Planning Region")
EARLIER_CONNECTICUT = ("003", "Hartford County")


def delineation(connecticut):
    fips, name = connecticut
    return workbook([
        county_row("25540", name, "09", fips),
        county_row("10180", "Taylor County", "48", "441"),
        county_row("10180", "Callahan County", "48", "059"),
        ["Note: OMB standards", None, None, None, None, None, None, None, None, None, None, None],
    ])


# a bea request carries query parameters and is answered by line and year
# list; a line and year with no canned response answers bea's error 101,
# which is what an unpublished year gets. a delineation download carries none,
# so any delineation url is answered with a workbook: the july 2023 one for
# the url the collector holds today, the pre change one for anything else
def fake_fetch(responses, urls):
    def fetch(url, params=None, **kwargs):
        if params is None:
            urls.append(url)
            ct = CURRENT_CONNECTICUT if url == irs.DELINEATION_URL else EARLIER_CONNECTICUT
            return FakeResponse(content=delineation(ct))
        return responses.get(f"{params['LineCode']}:{params['Year']}", FakeResponse(error_payload()))
    return fetch


# collect with both lines answered, reading back the metrics.csv it writes
def run_collect():
    responses = {f"1:{BULK}": FakeResponse(payload(income_rows(), "1")),
                 f"2:{BULK}": FakeResponse(payload(population_rows(), "2"))}
    with ExitStack() as stack:
        tmp = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        out_dir = tmp / "bea"
        stack.enter_context(mock.patch.dict(os.environ, {"BEA_API_KEY": FAKE_KEY}))
        stack.enter_context(mock.patch.object(bea, "OUT_DIR", out_dir))
        stack.enter_context(mock.patch.object(bea, "PAUSE_SECONDS", 0))
        stack.enter_context(mock.patch.object(bea, "this_year", lambda: THIS_YEAR))
        stack.enter_context(mock.patch.object(bea, "fetch", fake_fetch(responses, [])))
        with redirect_stdout(io.StringIO()):
            bea.collect()
        return pd.read_csv(out_dir / "metrics.csv", dtype={"cbsa_code": str, "period": str})


def value_of(out, code, metric, period):
    rows = out[(out.cbsa_code == code) & (out.metric == metric) & (out.period == period)]
    if len(rows) != 1:
        raise AssertionError(f"{len(rows)} rows for {code} {metric} {period}")
    return int(rows.value.iloc[0])


def periods_of(out, code):
    return sorted(out[out.cbsa_code == code].period.unique())


class TestConnecticutKeepsItsPreRegionYears(unittest.TestCase):
    # the control: a metro whose counties never changed code carries every
    # period bea published, and the sum is the two counties
    def test_abilene_carries_every_published_period(self):
        out = run_collect()
        self.assertEqual(periods_of(out, "10180"), PERIODS)
        self.assertEqual(value_of(out, "10180", "bea_personal_income", "2014"), ABILENE_INCOME_2014)

    # bea published hartford county for 2014 through 2023 and the capitol
    # planning region for 2024, an unbroken series over the same ground, so
    # hartford must carry the same periods abilene does
    def test_hartford_carries_every_published_period(self):
        out = run_collect()
        self.assertEqual(periods_of(out, "25540"), PERIODS)

    # a county value bea published must reach the cbsa that county belonged
    # to in that year, whichever delineation names it
    def test_hartford_county_years_reach_hartford(self):
        out = run_collect()
        self.assertEqual(value_of(out, "25540", "bea_personal_income", "2014"), HARTFORD_INCOME_2014)
        self.assertEqual(value_of(out, "25540", "bea_population", "2014"), HARTFORD_POPULATION_2014)
        self.assertEqual(value_of(out, "25540", "bea_income_per_capita", "2014"), HARTFORD_PER_CAPITA_2014)
        self.assertEqual(value_of(out, "25540", "bea_income_per_capita", "2019"), HARTFORD_PER_CAPITA_2019)
        self.assertEqual(value_of(out, "25540", "bea_income_per_capita", "2023"), HARTFORD_PER_CAPITA_2023)
        # the planning region year already arrives today
        self.assertEqual(value_of(out, "25540", "bea_income_per_capita", "2024"), HARTFORD_PER_CAPITA_2024)


if __name__ == "__main__":
    unittest.main()

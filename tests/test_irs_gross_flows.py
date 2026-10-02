# a county's Total Migration-US row counts every return that moved in from any
# other county, including a county of the same metro. summed into every code
# the county belongs to, a move from one county of a metro to another would
# land in the metro's gross inflow and in its gross outflow: the two cancel in
# the net and inflate both gross figures, which the map shows per metro as
# "IRS inflow, tax returns" and "IRS outflow, tax returns". so a metro's gross
# flows count only returns that crossed its edge. for a metropolitan division
# the line is the division: a move from another division of the same metro is
# inflow for the division and not for the parent.
#
# the collector is driven end to end through collect() with the network
# faked, so the test pins what lands in metrics.csv, not how the collector
# gets there

import io
import re
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest import mock

import pandas as pd

from bot.collectors import irs

ROOT = Path(__file__).resolve().parent.parent

# a synthetic filing year pair in the shape irs publishes, n2 twice n1
# throughout. autauga and elmore are montgomery 33860. cook and lake are
# chicago 16980, cook in the chicago division 16984 and lake in the lake
# county-kenosha county division 29404. every other move goes to or comes from
# another state, as other flows. the pair rows between the two counties of a
# metro appear once on each side: autauga from elmore in the inflow file is
# elmore to autauga in the outflow file, 400 returns either way
INFLOW_TEXT = (
    "y2_statefips,y2_countyfips,y1_statefips,y1_countyfips,y1_state,y1_countyname,n1,n2,agi\n"
    "1,1,96,0,AL,Autauga County Total Migration-US and Foreign,1410,2820,70500\n"
    "1,1,97,0,AL,Autauga County Total Migration-US,1400,2800,70000\n"
    "1,1,97,1,AL,Autauga County Total Migration-Same State,400,800,20000\n"
    "1,1,97,3,AL,Autauga County Total Migration-Different State,1000,2000,50000\n"
    "1,1,98,0,AL,Autauga County Total Migration-Foreign,10,20,500\n"
    "1,1,1,1,AL,Autauga County Non-migrants,19000,41000,1400000\n"
    "1,1,1,51,AL,Elmore County,400,800,20000\n"
    "1,1,59,0,DS,Other flows - Different State,1000,2000,50000\n"
    "1,51,96,0,AL,Elmore County Total Migration-US and Foreign,2300,4600,115000\n"
    "1,51,97,0,AL,Elmore County Total Migration-US,2300,4600,115000\n"
    "1,51,97,1,AL,Elmore County Total Migration-Same State,300,600,15000\n"
    "1,51,97,3,AL,Elmore County Total Migration-Different State,2000,4000,100000\n"
    "1,51,1,51,AL,Elmore County Non-migrants,30000,65000,2000000\n"
    "1,51,1,1,AL,Autauga County,300,600,15000\n"
    "1,51,59,0,DS,Other flows - Different State,2000,4000,100000\n"
    "17,31,97,0,IL,Cook County Total Migration-US,3500,7000,175000\n"
    "17,31,97,1,IL,Cook County Total Migration-Same State,500,1000,25000\n"
    "17,31,97,3,IL,Cook County Total Migration-Different State,3000,6000,150000\n"
    "17,31,17,97,IL,Lake County,500,1000,25000\n"
    "17,31,59,0,DS,Other flows - Different State,3000,6000,150000\n"
    "17,97,97,0,IL,Lake County Total Migration-US,1700,3400,85000\n"
    "17,97,97,1,IL,Lake County Total Migration-Same State,700,1400,35000\n"
    "17,97,97,3,IL,Lake County Total Migration-Different State,1000,2000,50000\n"
    "17,97,17,31,IL,Cook County,700,1400,35000\n"
    "17,97,59,0,DS,Other flows - Different State,1000,2000,50000\n"
)

OUTFLOW_TEXT = (
    "y1_statefips,y1_countyfips,y2_statefips,y2_countyfips,y2_state,y2_countyname,n1,n2,agi\n"
    "1,1,97,0,AL,Autauga County Total Migration-US,1200,2400,60000\n"
    "1,1,97,1,AL,Autauga County Total Migration-Same State,300,600,15000\n"
    "1,1,97,3,AL,Autauga County Total Migration-Different State,900,1800,45000\n"
    "1,1,1,1,AL,Autauga County Non-migrants,19000,41000,1400000\n"
    "1,1,1,51,AL,Elmore County,300,600,15000\n"
    "1,1,59,0,DS,Other flows - Different State,900,1800,45000\n"
    "1,51,97,0,AL,Elmore County Total Migration-US,1900,3800,95000\n"
    "1,51,97,1,AL,Elmore County Total Migration-Same State,400,800,20000\n"
    "1,51,97,3,AL,Elmore County Total Migration-Different State,1500,3000,75000\n"
    "1,51,1,51,AL,Elmore County Non-migrants,30000,65000,2000000\n"
    "1,51,1,1,AL,Autauga County,400,800,20000\n"
    "1,51,59,0,DS,Other flows - Different State,1500,3000,75000\n"
    "17,31,97,0,IL,Cook County Total Migration-US,4700,9400,235000\n"
    "17,31,97,1,IL,Cook County Total Migration-Same State,700,1400,35000\n"
    "17,31,97,3,IL,Cook County Total Migration-Different State,4000,8000,200000\n"
    "17,31,17,97,IL,Lake County,700,1400,35000\n"
    "17,31,59,0,DS,Other flows - Different State,4000,8000,200000\n"
    "17,97,97,0,IL,Lake County Total Migration-US,1300,2600,65000\n"
    "17,97,97,1,IL,Lake County Total Migration-Same State,500,1000,25000\n"
    "17,97,97,3,IL,Lake County Total Migration-Different State,800,1600,40000\n"
    "17,97,17,31,IL,Cook County,500,1000,25000\n"
    "17,97,59,0,DS,Other flows - Different State,800,1600,40000\n"
)

# hand computed from the fixture. montgomery: 700 returns moved between its
# own two counties, 400 from elmore to autauga and 300 the other way
MONTGOMERY_INFLOW = 1000 + 2000       # from outside, not 1400 + 2300 = 3700
MONTGOMERY_OUTFLOW = 900 + 1500       # to outside, not 1200 + 1900 = 3100
MONTGOMERY_NET = 3000 - 2400          # 600, the same as 3700 - 3100
MONTGOMERY_NET_EXEMPTIONS = 1200      # (2800 + 4600) - (2400 + 3800)

# chicago: 1200 returns moved between its two divisions, 500 from lake to
# cook and 700 the other way. each is migration for the division it entered
# and the division it left, and neither is migration for chicago
COOK_DIVISION_INFLOW, COOK_DIVISION_OUTFLOW = 3500, 4700
LAKE_DIVISION_INFLOW, LAKE_DIVISION_OUTFLOW = 1700, 1300
CHICAGO_INFLOW = 3000 + 1000          # not 3500 + 1700 = 5200
CHICAGO_OUTFLOW = 4000 + 800          # not 4700 + 1300 = 6000
CHICAGO_NET = 4000 - 4800             # -800, the same as 5200 - 6000

# the pair irs files report under their second year: 2021 to 2022 is 2022
PERIOD = "2022"
LAST_KNOWN_PAIR = irs.KNOWN_THROUGH

HEADER = ["CBSA Code", "Metropolitan Division Code", "CSA Code", "CBSA Title",
          "Metropolitan/Micropolitan Statistical Area", "Metropolitan Division Title", "CSA Title",
          "County/County Equivalent", "State Name", "FIPS State Code", "FIPS County Code",
          "Central/Outlying County"]


def county_row(cbsa, division, county, state_fips, county_fips):
    return [cbsa, division, None, "Title", "Metropolitan Statistical Area", None, None,
            county, "State", state_fips, county_fips, "Central"]


# a workbook shaped like list1_2023.xlsx: two title rows, the header, county
# rows, then a note row the census bureau appends
def delineation():
    rows = [
        county_row("33860", None, "Autauga County", "01", "001"),
        county_row("33860", None, "Elmore County", "01", "051"),
        county_row("16980", "16984", "Cook County", "17", "031"),
        county_row("16980", "29404", "Lake County", "17", "097"),
        ["Note: OMB standards", None, None, None, None, None, None, None, None, None, None, None],
    ]
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        pd.DataFrame(rows, columns=HEADER).to_excel(writer, index=False, startrow=2, sheet_name="List 1")
        writer.sheets["List 1"]["A1"] = "List 1. Core based statistical areas, July 2023"
    return buffer.getvalue()


class FakeResponse:
    def __init__(self, status=200, content=b""):
        self.status_code = status
        self.content = content

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


# the delineation answers with the workbook. every filing year pair irs is
# known to publish answers with the same fixture, and the first newer pair
# answers 404, which is how irs says a pair does not exist yet
def fake_fetch(workbook):
    def fetch(url, params=None, **kwargs):
        if url.endswith(".xlsx"):
            return FakeResponse(content=workbook)
        found = re.search(r"county(inflow|outflow)(\d{2})\d{2}\.csv$", url)
        if found and 2000 + int(found.group(2)) <= LAST_KNOWN_PAIR:
            text = INFLOW_TEXT if found.group(1) == "inflow" else OUTFLOW_TEXT
            return FakeResponse(content=text.encode())
        return FakeResponse(status=404)
    return fetch


# collect with the network faked, reading back the metrics.csv it writes
def run_collect():
    with ExitStack() as stack:
        tmp = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        out_dir = tmp / "irs"
        stack.enter_context(mock.patch.object(irs, "OUT_DIR", out_dir))
        stack.enter_context(mock.patch.object(irs, "OUT_FILE", out_dir / "metrics.csv"))
        stack.enter_context(mock.patch.object(irs, "fetch", fake_fetch(delineation())))
        with redirect_stdout(io.StringIO()):
            irs.collect()
        return pd.read_csv(out_dir / "metrics.csv", dtype={"cbsa_code": str, "period": str})


def value_of(out, code, metric, period=PERIOD):
    rows = out[(out.cbsa_code == code) & (out.metric == metric) & (out.period == period)]
    if len(rows) != 1:
        raise AssertionError(f"{len(rows)} rows for {code} {metric} {period}")
    return int(rows.value.iloc[0])


class TestAMoveInsideAMetroIsNotMigrationForIt(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = run_collect()

    def test_inflow_counts_only_returns_that_came_from_outside_the_metro(self):
        self.assertEqual(value_of(self.out, "33860", "irs_inflow_returns"), MONTGOMERY_INFLOW)

    def test_outflow_counts_only_returns_that_left_the_metro(self):
        self.assertEqual(value_of(self.out, "33860", "irs_outflow_returns"), MONTGOMERY_OUTFLOW)

    # the control: a move inside the metro cancels in the net
    def test_the_net_is_the_same_either_way(self):
        self.assertEqual(value_of(self.out, "33860", "irs_net_returns"), MONTGOMERY_NET)
        self.assertEqual(value_of(self.out, "33860", "irs_net_exemptions"), MONTGOMERY_NET_EXEMPTIONS)
        self.assertEqual(value_of(self.out, "33860", "irs_net_returns"),
                         value_of(self.out, "33860", "irs_inflow_returns")
                         - value_of(self.out, "33860", "irs_outflow_returns"))


class TestAMoveBetweenTwoDivisionsOfOneMetro(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = run_collect()

    # the control: a move from lake to cook left one division and entered the other
    def test_is_migration_for_each_division(self):
        self.assertEqual(value_of(self.out, "16984", "irs_inflow_returns"), COOK_DIVISION_INFLOW)
        self.assertEqual(value_of(self.out, "16984", "irs_outflow_returns"), COOK_DIVISION_OUTFLOW)
        self.assertEqual(value_of(self.out, "29404", "irs_inflow_returns"), LAKE_DIVISION_INFLOW)
        self.assertEqual(value_of(self.out, "29404", "irs_outflow_returns"), LAKE_DIVISION_OUTFLOW)

    def test_is_not_migration_for_the_metro_both_divisions_belong_to(self):
        self.assertEqual(
            (value_of(self.out, "16980", "irs_inflow_returns"), value_of(self.out, "16980", "irs_outflow_returns")),
            (CHICAGO_INFLOW, CHICAGO_OUTFLOW))

    # the control: the parent's net is still the sum of its divisions' nets
    def test_the_parent_net_is_unchanged(self):
        self.assertEqual(value_of(self.out, "16980", "irs_net_returns"), CHICAGO_NET)


# the same rule on the shipped table, data/raw/irs/metrics.csv. the county
# files are parsed in memory and never archived, so the double count can only
# be read off the table where one code is made of others: every county of a
# parent metro sits in one of its divisions, so the parent's gross inflow is
# the sum of its divisions' less every return that moved between two of them.
# a parent equal to that sum, year after year, is the double count itself.
# the map shows the divisions in place of their parents
class TestTheShippedTable(unittest.TestCase):
    def setUp(self):
        path = ROOT / "data" / "raw" / "irs" / "metrics.csv"
        if not path.exists():
            self.skipTest("irs metrics.csv is not on disk")
        self.frame = pd.read_csv(path, dtype={"cbsa_code": str, "period": str})
        merged = pd.read_csv(ROOT / "data" / "integrated" / "hpi_census_merged.csv",
                             dtype={"cbsa_code": str, "parent_cbsa": str}, usecols=["cbsa_code", "parent_cbsa"])
        pairs = merged.dropna(subset=["parent_cbsa"]).drop_duplicates()
        self.divisions = pairs.groupby("parent_cbsa").cbsa_code.apply(sorted).to_dict()

    def test_a_parent_metro_moves_fewer_returns_than_its_divisions_added_together(self):
        self.assertTrue(self.divisions, "no division rows in the integrated csv")
        at_the_sum = []
        for parent, divisions in sorted(self.divisions.items()):
            for metric in ("irs_inflow_returns", "irs_outflow_returns"):
                rows = self.frame[self.frame.metric == metric]
                for period in sorted(rows[rows.cbsa_code == parent].period):
                    parts = rows[rows.cbsa_code.isin(divisions) & (rows.period == period)]
                    if len(parts) != len(divisions):
                        continue
                    whole = int(rows[(rows.cbsa_code == parent) & (rows.period == period)].value.iloc[0])
                    if whole >= int(parts.value.sum()):
                        at_the_sum.append(f"{parent} {metric} {period} {whole}")
        self.assertEqual(len(at_the_sum), 0, f"parent metro-years whose gross flow is the plain sum of "
                                             f"their divisions', for example {at_the_sum[:3]}")


if __name__ == "__main__":
    unittest.main()

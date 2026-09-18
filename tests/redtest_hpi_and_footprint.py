# run from the project root:
#   ml/.venv/bin/python -m unittest tests.redtest_hpi_and_footprint -v

import json
import sys
import unittest
from pathlib import Path

from bot import build_map_data as bm

# scripts/ is not a package, so put it on the path before importing
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import download_census as dc

V0, V1, V2 = [str(y) for y in bm.STUDY_YEARS]

# the year panel rounds an annual mean to two decimals and the price history
# rounds the same mean to one, so two readings of one published index agree to
# within a rounding step rather than exactly
ROUNDING = 0.06

# cleveland is one of the metros the census side of the join has no 2014 or
# 2019 row for. fhfa published all four quarters of both years, and the price
# history in the metro's own payload draws them
CLEVELAND = "17410"
CLEVELAND_2014 = 127.5
CLEVELAND_2019 = 156.2
CLEVELAND_HPI_14_19 = 0.2251

# the four indiana counties gary held in 2014 under code 23844 and lake
# county-porter county-jasper county holds in 2024 under 29414. same ground,
# same four counties, a new number on it
GARY = "29414"
GARY_OLD = "23844"
GARY_COUNTIES = frozenset({"18073", "18089", "18111", "18127"})
GARY_POP_14_24 = 0.0224
GARY_INCOME_14_24 = 0.4315
GARY_HOME_VALUE_14_24 = 0.6591

# chicago's division was renumbered too, and it did give up kendall county,
# 1.62 percent of its people, which is inside the tolerance a tidied boundary
# is allowed
CHICAGO_DIVISION = "16984"
CHICAGO_DIVISION_OLD = "16974"
KENDALL = "17093"
CHICAGO_POP_14_24 = -0.0182
CHICAGO_INCOME_14_24 = 0.4787
CHICAGO_HOME_VALUE_14_24 = 0.4594
CHICAGO_MOVED = 0.0162

# the decade population rate each renumbered division can report, from the
# counties its old code held in 2014 and its new code holds in 2024. the
# lakewood-new brunswick row has no 2014 census row at all, so it has nothing
# to compare and reports nothing
RENUMBERED_POP_14_24 = {
    "29414": GARY_POP_14_24,
    "16984": CHICAGO_POP_14_24,
    "23224": 0.0873,
    "29484": None,
}


# the index a price history carries for one year, none when the history does
# not reach that year
def index_at(history, year):
    if not history:
        return None
    place = int(year) - history["start"]
    return history["values"][place] if 0 <= place < len(history["values"]) else None


# the value the shipped payload's own price history plots for a vintage year
def plotted(metro, year):
    return index_at((metro.get("series") or {}).get("hpi"), year)


def shipped_metros():
    payload = json.loads((bm.WEB_DATA_DIR / "metros.json").read_text())
    return {metro["cbsa"]: metro for metro in payload["metros"]}


# an index fhfa published for a metro-year belongs in that year's panel,
# whatever the census join did with the row. the map reads the panel and the
# detail chart reads the price history, and they are the same number
class TestAPublishedIndexReachesTheYearPanel(unittest.TestCase):
    # every metro-year at fault is named rather than counted
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.metros = shipped_metros()

    def test_cleveland_2014_carries_the_index_its_own_chart_plots(self):
        cleveland = self.metros[CLEVELAND]
        self.assertEqual(plotted(cleveland, V0), CLEVELAND_2014)
        panel = cleveland["years"][V0]
        # the rest of the 2014 record arrived, so the year itself is not the gap
        self.assertIsNotNone(panel["zhvi"])
        self.assertIsNotNone(panel["unemp"])
        self.assertIsNotNone(panel["hpi"], f"2014 hpi is null while the same record plots {CLEVELAND_2014}")
        self.assertAlmostEqual(panel["hpi"], CLEVELAND_2014, delta=ROUNDING)

    def test_cleveland_keeps_the_decade_rate_those_two_indexes_make(self):
        cleveland = self.metros[CLEVELAND]
        self.assertEqual(plotted(cleveland, V0), CLEVELAND_2014)
        self.assertEqual(plotted(cleveland, V1), CLEVELAND_2019)
        self.assertEqual(cleveland["growth"]["hpi_14_19"], CLEVELAND_HPI_14_19)

    def test_no_vintage_is_blank_while_the_history_carries_it(self):
        blank = []
        for cbsa, metro in sorted(self.metros.items()):
            for year in (V0, V1, V2):
                published = plotted(metro, year)
                if metro["years"][year]["hpi"] is None and published is not None:
                    blank.append(f"{cbsa} {metro['name']} {year} fhfa published {published}")
        self.assertEqual(blank, [])

    def test_a_pair_fhfa_published_both_ends_of_has_its_growth_rate(self):
        lost = []
        for cbsa, metro in sorted(self.metros.items()):
            for key, earlier, later in (("hpi_14_19", V0, V1), ("hpi_19_24", V1, V2)):
                ends = (plotted(metro, earlier), plotted(metro, later))
                if metro["growth"][key] is None and None not in ends:
                    lost.append(f"{cbsa} {metro['name']} {key} from {ends[0]} to {ends[1]}")
        self.assertEqual(lost, [])

    # the control: where the panel does carry an index it is the published one,
    # so the two readings differ by nothing but their rounding
    def test_the_panel_and_the_history_agree_where_both_are_there(self):
        for cbsa, metro in sorted(self.metros.items()):
            for year in (V0, V1, V2):
                panel, published = metro["years"][year]["hpi"], plotted(metro, year)
                if panel is not None and published is not None:
                    self.assertAlmostEqual(panel, published, delta=ROUNDING, msg=f"{cbsa} {year}")


# the same defect with the shipped file out of the way: build_metros is handed
# the fhfa series it gives the detail chart while it is filling the year panel
class TestTheYearPanelIsBuiltFromWhatFhfaPublished(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        merged = bm.load_merged(bm.DEFAULT_PATHS["merged"])
        cls.rows = merged[merged["cbsa_code"] == CLEVELAND]
        centroids = bm.load_centroids(bm.DEFAULT_PATHS["centroids"])
        cls.series = bm.load_fhfa_series(bm.DEFAULT_PATHS["fhfa"])
        cls.metro = bm.build_metros(cls.rows, centroids, series=cls.series)[0][0]

    # the census side is the one with no row, which is what the panel is reading
    def test_the_census_join_carries_only_2024_for_cleveland(self):
        self.assertEqual(sorted(str(int(year)) for year in self.rows["year"]), [V2])

    def test_the_build_fills_the_panel_from_the_series_it_holds(self):
        history = self.series[CLEVELAND]
        self.assertEqual(index_at(history, V0), CLEVELAND_2014)
        panel = self.metro["years"][V0]["hpi"]
        self.assertIsNotNone(panel, f"2014 hpi is null while the build holds {CLEVELAND_2014} for that metro-year")
        self.assertAlmostEqual(panel, CLEVELAND_2014, delta=ROUNDING)

    def test_the_decade_rate_follows_from_the_two_published_indexes(self):
        self.assertEqual(index_at(self.series[CLEVELAND], V1), CLEVELAND_2019)
        self.assertEqual(self.metro["growth"]["hpi_14_19"], CLEVELAND_HPI_14_19)

    # the year the census join did have is untouched by any of this
    def test_the_2024_panel_is_unchanged(self):
        self.assertEqual(self.metro["years"][V2]["hpi"], 242.66)


# the footprint guard compares the county set a metro actually had at each
# vintage. omb renumbers a division without moving a county under it, so the
# guard has to follow the renumbering rather than be defeated by it
class TestARenumberedDivisionKeepsItsFootprint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.merged = bm.load_merged(bm.DEFAULT_PATHS["merged"])
        cls.centroids = bm.load_centroids(bm.DEFAULT_PATHS["centroids"])
        cls.membership = bm.load_membership(bm.DEFAULT_PATHS["membership"])
        cls.population = bm.load_county_population(bm.DEFAULT_PATHS["county_population"])

    def metro(self, cbsa):
        rows = self.merged[self.merged["cbsa_code"] == cbsa]
        metros, _, _ = bm.build_metros(rows, self.centroids, membership=self.membership,
                                       county_population=self.population)
        return metros[0]

    # the crosswalk the census download joins on is the record of which old
    # code is which new one
    def test_the_crosswalk_names_the_old_code_of_each_division(self):
        self.assertEqual(dc.DIVISION_CROSSWALK[GARY_OLD], GARY)
        self.assertEqual(dc.DIVISION_CROSSWALK[CHICAGO_DIVISION_OLD], CHICAGO_DIVISION)

    def test_gary_is_the_same_four_counties_under_both_of_its_codes(self):
        self.assertEqual(self.membership[V0][GARY_OLD], GARY_COUNTIES)
        self.assertEqual(self.membership[V2][GARY], GARY_COUNTIES)
        self.assertNotIn(GARY, self.membership[V0])

    def test_gary_reports_the_decade_it_spent_as_the_same_four_counties(self):
        gary = self.metro(GARY)
        self.assertEqual(gary["growth"]["pop_14_24"], GARY_POP_14_24)
        self.assertEqual(gary["growth"]["income_14_24"], GARY_INCOME_14_24)
        self.assertEqual(gary["growth"]["home_value_14_24"], GARY_HOME_VALUE_14_24)
        # not one county moved, so there is no boundary note to make
        self.assertNotIn("footprint_moved", gary)

    def test_the_chicago_division_gave_up_one_county_and_says_so(self):
        earlier = self.membership[V0][CHICAGO_DIVISION_OLD]
        later = self.membership[V2][CHICAGO_DIVISION]
        self.assertEqual(earlier - later, frozenset({KENDALL}))
        self.assertEqual(later - earlier, frozenset())
        chicago = self.metro(CHICAGO_DIVISION)
        self.assertEqual(chicago["growth"]["pop_14_24"], CHICAGO_POP_14_24)
        self.assertEqual(chicago["growth"]["income_14_24"], CHICAGO_INCOME_14_24)
        self.assertEqual(chicago["growth"]["home_value_14_24"], CHICAGO_HOME_VALUE_14_24)
        self.assertEqual(chicago["footprint_moved"], CHICAGO_MOVED)
        self.assertLess(chicago["footprint_moved"], bm.FOOTPRINT_TOLERANCE)

    # all four of them, since a fix scoped to one metro is what left the others
    def test_every_renumbered_division_reports_the_decade_its_counties_allow(self):
        reported = {cbsa: self.metro(cbsa)["growth"]["pop_14_24"] for cbsa in sorted(RENUMBERED_POP_14_24)}
        self.assertEqual(reported, {cbsa: RENUMBERED_POP_14_24[cbsa] for cbsa in sorted(RENUMBERED_POP_14_24)})


# the integrated file is short of 33 metro-years, and the report blames fhfa
# for them. fhfa published every one: it is the census side that has no row
class TestTheReportNamesTheSideOfTheJoinThatIsMissing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        merged = bm.load_merged(bm.DEFAULT_PATHS["merged"])
        series = bm.load_fhfa_series(bm.DEFAULT_PATHS["fhfa"])
        have = set(zip(merged["cbsa_code"], (str(int(y)) for y in merged["year"])))
        codes = sorted({code for code, _ in have})
        cls.missing = [(c, y) for c in codes for y in (V0, V1, V2) if (c, y) not in have]
        cls.published = [(c, y) for c, y in cls.missing if index_at(series.get(c), y) is not None]

    def test_every_row_the_join_is_short_of_was_published_by_fhfa(self):
        self.assertGreater(len(self.missing), 0)
        self.assertEqual(self.published, self.missing)

    def test_the_report_does_not_call_them_metros_without_fhfa_data(self):
        report = (bm.BASE_DIR / "docs" / "REPORT.md").read_text()
        said = [line for line in report.splitlines() if "missing rows" in line]
        self.assertEqual(len(said), 1)
        self.assertNotIn("without FHFA data", said[0])


if __name__ == "__main__":
    unittest.main()

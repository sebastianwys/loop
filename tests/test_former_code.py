# the panel side of the same rule is ml/tests/test_former_code.py

import json
import unittest

from bot import build_map_data as bm
from bot.common import STUDY_YEARS

# a metro omb renumbered without redrawing it is the same metro, so the census
# join carries the older vintages onto the current code. cleveland 17410 was
# 17460, and its 2014 and 2019 panels publish the acs income those vintages
# filed under 17460
CLEVELAND, CLEVELAND_OLD = "17410", "17460"
CLEVELAND_2014_INCOME = 49551.0
# the acs 2014 median gross rent the same vintage filed under 17460
CLEVELAND_2014_GROSS_RENT = 750.0

# gary is the division renumbered 23844 to 29414 on the same four counties.
# pep filed its 2010 to 2019 estimates under the old code
GARY, GARY_OLD = "29414", "23844"
GARY_2014_POP_ESTIMATE = 705792.0


def enrichment_sources():
    return bm.discover_enrichments(bm.DEFAULT_PATHS["enrichment_dir"], bm.DEFAULT_PATHS["forecast_dir"])


# the value a source published for a metro and year, under the metro's code or
# the code it carried before omb renumbered it, whichever filed it
def published(source, code, metric, year):
    for filed in (code, bm.FORMER_CODE.get(code)):
        annual, _ = bm.enrich_values(source["groups"].get(filed))
        if (metric, year) in annual:
            return annual[(metric, year)]
    return None


# every renumbered metro, built the way the map build builds it, from the
# files on disk and in memory, so nothing is written
class TestAValueFiledUnderTheFormerCodeReachesTheYearPanel(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        merged = bm.load_merged(bm.DEFAULT_PATHS["merged"])
        centroids = bm.load_centroids(bm.DEFAULT_PATHS["centroids"])
        cls.sources = enrichment_sources()
        rows = merged[merged["cbsa_code"].isin(bm.FORMER_CODE)]
        metros, _, _ = bm.build_metros(rows, centroids, enrichments=cls.sources)
        cls.metros = {m["cbsa"]: m for m in metros}

    def source(self, name):
        return next(s for s in self.sources if s["name"] == name)

    def test_the_crosswalk_calls_them_one_metro(self):
        self.assertEqual(bm.FORMER_CODE[CLEVELAND], CLEVELAND_OLD)
        self.assertEqual(bm.FORMER_CODE[GARY], GARY_OLD)

    # the core acs of that vintage is on the panel already, which is what makes
    # a null beside it a join gap and not a missing survey
    def test_cleveland_2014_carries_the_rent_its_2014_vintage_published(self):
        panel = self.metros[CLEVELAND]["years"]["2014"]
        self.assertEqual(panel["income"], CLEVELAND_2014_INCOME)
        self.assertEqual(published(self.source("acs"), CLEVELAND, "gross_rent", 2014), CLEVELAND_2014_GROSS_RENT)
        self.assertEqual(panel["gross_rent"], CLEVELAND_2014_GROSS_RENT,
                         "acs published cleveland's 2014 gross rent under 17460 and the panel shows null")

    def test_gary_2014_carries_the_population_pep_estimated_for_it(self):
        self.assertEqual(published(self.source("pep"), GARY, "pop_estimate", 2014), GARY_2014_POP_ESTIMATE)
        self.assertEqual(self.metros[GARY]["years"]["2014"]["pop_estimate"], GARY_2014_POP_ESTIMATE)

    # the golden: every value any source filed for a renumbered metro in a study
    # year, under either of its codes, is on that metro's year panel
    def test_no_year_panel_cell_is_null_while_a_source_published_it(self):
        blank = []
        for code, metro in sorted(self.metros.items()):
            for source in self.sources:
                for metric in source["metrics"]:
                    for year in STUDY_YEARS:
                        value = published(source, code, metric, year)
                        if value is not None and metro["years"][str(year)][metric] != bm.rnd(value, 4):
                            blank.append(f"{code} {year} {source['name']}.{metric} published {value}, "
                                         f"panel {metro['years'][str(year)][metric]}")
        self.assertEqual(blank, [], f"{len(blank)} cells")


# the file the site serves, the same cell
class TestTheShippedMapCarriesIt(unittest.TestCase):
    def test_cleveland_2014_gross_rent_on_the_live_map(self):
        payload = json.loads((bm.WEB_DATA_DIR / "metros.json").read_text())
        cleveland = next(m for m in payload["metros"] if m["cbsa"] == CLEVELAND)
        self.assertEqual(cleveland["years"]["2014"]["income"], CLEVELAND_2014_INCOME)
        self.assertEqual(cleveland["years"]["2014"]["gross_rent"], CLEVELAND_2014_GROSS_RENT)


if __name__ == "__main__":
    unittest.main()

# the page side of the same note, a share over one hundred percent, is in
# web/src/lib/footprint.test.ts

import unittest

from bot import build_map_data as bm

DECADE_RATES = ("income_14_24", "pop_14_24", "home_value_14_24")

# the shares the populations weigh: houston tidied a boundary, lynchburg lost a
# county nobody lives in, salisbury was redrawn
HOUSTON, HOUSTON_MOVED = "26420", 0.0046
LYNCHBURG = "31340"
SALISBURY, SALISBURY_REFUSED = "41540", 0.6685


# footprint_refused is the share of a metro's people that changed hands, set
# when the move was too far for a rate, and the page prints it
# as "carrying N percent of its people". footprint_move answers 1.0 for a move
# it could not weigh, which is the right call for withholding the rate and the
# wrong number to publish: nobody measured it
class TestARefusedShareIsAMeasuredShare(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.merged = bm.load_merged(bm.DEFAULT_PATHS["merged"])
        cls.centroids = bm.load_centroids(bm.DEFAULT_PATHS["centroids"])
        cls.membership = bm.load_membership(bm.DEFAULT_PATHS["membership"])
        cls.population = bm.load_county_population(bm.DEFAULT_PATHS["county_population"])

    def metro(self, cbsa, population, membership=None):
        rows = self.merged[self.merged["cbsa_code"] == cbsa]
        metros, _, _ = bm.build_metros(rows, self.centroids, membership=membership or self.membership,
                                       county_population=population)
        return metros[0]

    def assertWithheldWithoutAShare(self, metro, measured):
        for key in DECADE_RATES:
            self.assertIsNone(metro["growth"][key], f"{metro['cbsa']} {key}")
        # withheld, not unmeasured: the metro still says its rates were refused
        self.assertTrue(any(key.startswith("footprint_") for key in metro),
                        f"{metro['cbsa']} withholds its rates and no longer says so")
        refused = metro.get("footprint_refused")
        self.assertNotIn(type(refused), (int, float),
                         f"{metro['cbsa']} publishes footprint_refused {refused}, a share nobody weighed "
                         f"(the populations weigh it at {measured})")

    # the controls: with the populations on disk each share is the measured one
    def test_with_the_populations_the_shares_are_measured(self):
        self.assertEqual(self.metro(HOUSTON, self.population)["footprint_moved"], HOUSTON_MOVED)
        self.assertEqual(self.metro(LYNCHBURG, self.population)["footprint_moved"], 0.0)
        self.assertEqual(self.metro(SALISBURY, self.population)["footprint_refused"], SALISBURY_REFUSED)

    # a first build, or one without county_population_by_vintage.csv. the rates
    # are withheld, and a published share would say 100.00 percent of houston's
    # people moved when 0.46 percent did
    def test_without_the_populations_houston_is_not_published_as_all_of_its_people(self):
        self.assertWithheldWithoutAShare(self.metro(HOUSTON, None), HOUSTON_MOVED)

    def test_without_the_populations_lynchburg_is_not_published_as_all_of_its_people(self):
        self.assertWithheldWithoutAShare(self.metro(LYNCHBURG, None), 0.0)

    def test_without_the_populations_salisbury_is_not_published_as_all_of_its_people(self):
        self.assertWithheldWithoutAShare(self.metro(SALISBURY, None), SALISBURY_REFUSED)

    # the other sentinel: a code a vintage's delineation does not carry falls
    # back to the state list in the acs name, and md-de to md is a change. the
    # county set of that vintage is unknown, so there is no share to publish
    def test_a_state_list_change_on_a_code_the_delineation_lacks_publishes_no_share(self):
        membership = dict(self.membership)
        membership["2014"] = {code: counties for code, counties in self.membership["2014"].items() if code != SALISBURY}
        self.assertWithheldWithoutAShare(self.metro(SALISBURY, self.population, membership), SALISBURY_REFUSED)


if __name__ == "__main__":
    unittest.main()

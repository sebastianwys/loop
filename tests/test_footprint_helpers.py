import unittest

from bot import build_map_data as bm

# jackson tn held chester, crockett and madison on february 2013 and took in
# gibson on september 2018
MEMBERSHIP = {
    "2014": {"27180": frozenset({"47023", "47033", "47113"}), "19380": frozenset({"39113"})},
    "2019": {"27180": frozenset({"47023", "47033", "47113", "47053"}), "19430": frozenset({"39113"})},
}
PEOPLE = {
    "2014": {"47023": 17000.0, "47033": 14000.0, "47113": 98000.0, "47053": 49000.0, "39113": 530000.0},
    "2019": {"47023": 17200.0, "47033": 14100.0, "47113": 98500.0, "47053": 49100.0, "39113": 531000.0},
}


class TestDelineations(unittest.TestCase):

    def test_bps_files_three_delineations(self):
        self.assertEqual([bm.bps_delineation(y) for y in (2014, 2018, 2019, 2023, 2024, 2025)],
                         ["2014", "2014", "2019", "2019", "2024", "2024"])

    def test_pep_switches_with_the_2020_base(self):
        self.assertEqual([bm.pep_delineation(y) for y in (2010, 2019, 2020, 2025)], ["2019", "2019", "2024", "2024"])

    def test_the_two_sources_agree_only_in_2019_and_from_2024(self):
        agree = [y for y in range(2014, 2026) if bm.bps_delineation(y) == bm.pep_delineation(y)]
        self.assertEqual(agree, [2019, 2024, 2025])


class TestFootprintShare(unittest.TestCase):

    def test_a_county_joining_is_weighed_by_its_people(self):
        share = bm.footprint_share(MEMBERSHIP, PEOPLE, "27180", "2019", "2014")
        self.assertAlmostEqual(share, 49100.0 / (17000.0 + 14000.0 + 98000.0))

    def test_the_same_counties_are_the_same_place(self):
        self.assertIsNone(bm.footprint_share(MEMBERSHIP, PEOPLE, "27180", "2014", "2014"))

    def test_a_renumbered_code_is_read_through_its_former_code(self):
        self.assertEqual(bm.FORMER_CODE.get("19430"), "19380")
        self.assertIsNone(bm.footprint_share(MEMBERSHIP, PEOPLE, "19430", "2019", "2014"))

    def test_a_code_a_delineation_does_not_carry_is_not_a_change(self):
        self.assertIsNone(bm.footprint_share(MEMBERSHIP, PEOPLE, "99999", "2019", "2014"))

    def test_a_move_nobody_can_weigh_is_still_a_move(self):
        self.assertEqual(bm.footprint_share(MEMBERSHIP, None, "27180", "2019", "2014"), 1.0)


if __name__ == "__main__":
    unittest.main()

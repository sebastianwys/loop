import json
import math
import statistics
import sys
import unittest
from pathlib import Path

import pandas as pd

from bot import build_map_data as bm
from bot.collectors import bps, pep

# the seam growth is measured with the ml package's own panel helpers. ci
# installs the root requirements only, so the tests that need them skip there
try:
    from loop import panel as loop_panel
except ImportError:
    loop_panel = None

needs_loop = unittest.skipIf(loop_panel is None, "needs the ml package, loop")

# scripts/ is not a package, so put it on the path before importing
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import download_census as dc

RAW_DIR = Path(__file__).parent.parent / "data" / "raw"
PEP_DIR = RAW_DIR / "pep"
BPS_DIR = RAW_DIR / "bps"

# the two pep files the collector stacks. vintage 2019 closed the 2010 base
# series and totals every area on the september 2018 delineation; vintage 2025
# starts from the 2020 count and totals every area on the july 2023 one. the
# newer file begins in 2020, so the 2019 to 2020 step is the one that spans both
OLD_VINTAGE, NEW_VINTAGE = pep.LEGACY_VINTAGE, 2025
SEAM = 2020
COUNTY = "County or equivalent"

# the vintage keys cbsa_counties_by_vintage files each delineation under
FEB_2013, SEPT_2018, JULY_2023 = "2014", "2019", "2024"

SALISBURY, SUSSEX_DE, WORCESTER_MD = "41540", "10005", "24047"
NEW_HAVEN, NEW_HAVEN_COUNTY, SOUTH_CENTRAL_REGION = "35300", "09009", "09170"
BEND, CROOK, JEFFERSON = "13460", "41013", "41031"
ABILENE = "10180"

# how far the seam step may sit from the mean of the steps either side of it.
# the closure alone moves no study metro's seam step further than 0.075 from
# its neighbours, so a step past 0.10 is a redraw
REDRAW = 0.10
# abilene's own steps either side of the seam are 0.0053 and 0.0059
CLOSURE = 0.01
# the years whose step and both neighbouring steps sit inside one file
CONTROL_YEARS = [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2022, 2023, 2024]

# jackson tn was chester, crockett and madison on the february 2013
# delineation and took in gibson on the september 2018 one. bps counted 205
# units over the three counties in 2014, and pep's own 2014 estimate for those
# three is 129,922
JACKSON_TN, GIBSON = "27180", "47053"
JACKSON_2014 = 205 * 1000 / 129_922
# salisbury held the same four counties on both of those delineations
SALISBURY_2014 = 2796 * 1000 / 388_766
# a rate within this share of the one over the permit counties is that rate
SAME_RATE = 0.02

# the villages is sumter county on all three delineations, 45540 until july
# 2023 made it 48680. these are the figures pep and bps printed under 45540
THE_VILLAGES, THE_VILLAGES_OLD, SUMTER = "48680", "45540", "12119"
VILLAGES_POP = {2014: 112_236.0, 2019: 132_420.0}
VILLAGES_PERMITS = {2014: 2_570.0, 2019: 2_928.0}


def pep_counties(vintage):
    frame = pd.read_csv(PEP_DIR / f"cbsa-est{vintage}-alldata.csv", dtype=str, encoding="latin-1",
                        keep_default_na=False)
    rows = frame[frame["LSAD"].str.strip() == COUNTY]
    return rows.assign(STCOU=rows["STCOU"].str.strip().str.zfill(5))


# pep prints every county inside the areas it totals, in the same file, so the
# counties behind a code in a vintage are read off that vintage itself
def county_sets(rows):
    out = {}
    for column in ("CBSA", "MDIV"):
        code = rows[column].str.strip()
        keyed = rows[code != ""]
        for key, group in keyed.groupby(code[code != ""].str.zfill(5)):
            out[key] = frozenset(group["STCOU"])
    return out


def county_population(rows, year):
    unique = rows.drop_duplicates("STCOU")
    return dict(zip(unique["STCOU"], pd.to_numeric(unique[f"POPESTIMATE{year}"], errors="coerce").astype(float)))


# the population series the collector writes to metrics.csv, made from the two
# files on disk the way collect() makes it: each vintage parsed, then merged
def published_population():
    frames = {v: pep.parse_vintage((PEP_DIR / f"cbsa-est{v}-alldata.csv").read_bytes())
              for v in (OLD_VINTAGE, NEW_VINTAGE)}
    merged = pep.merge_vintages(frames)
    rows = merged[merged["metric"] == "pop_estimate"]
    return {(c, int(p)): float(v) for c, p, v in zip(rows["cbsa_code"], rows["period"], rows["value"])}


# the permit series the collector writes, from every annual file on disk
def published_permits():
    frames, year = [], bps.FIRST_YEAR
    while (BPS_DIR / bps.file_url(year).rsplit("/", 1)[-1]).exists():
        text = (BPS_DIR / bps.file_url(year).rsplit("/", 1)[-1]).read_bytes().decode("latin-1")
        frames.append(bps.parse_annual(text))
        year += 1
    metrics = bps.annual_metrics(pd.concat(frames, ignore_index=True))
    rows = metrics[metrics["metric"] == "permits_units"]
    return {(c, int(p)): float(v) for c, p, v in zip(rows["cbsa_code"], rows["period"], rows["value"])}


# the codes a bps annual prints, read off the publisher's file rather than
# through the collector, so a collector that renames a code cannot move them
def printed_codes(year):
    text = (BPS_DIR / bps.file_url(year).rsplit("/", 1)[-1]).read_bytes().decode("latin-1")
    return {fields[2].strip() for fields in (line.split(",") for line in text.splitlines()) if len(fields) > 2}


def bps_delineation(year):
    return FEB_2013 if year <= 2018 else SEPT_2018 if year <= 2023 else JULY_2023


def log_step(pop, code, year):
    earlier, later = pop.get((code, year - 1)), pop.get((code, year))
    if earlier is None or later is None or earlier <= 0 or later <= 0:
        return None
    return math.log(later / earlier)


# a year's step less the mean of the steps either side of it, none when the
# step itself is not published
def off_neighbours(pop, code, year):
    here = log_step(pop, code, year)
    around = [s for s in (log_step(pop, code, year - 1), log_step(pop, code, year + 1)) if s is not None]
    return None if here is None or not around else here - sum(around) / len(around)


def study_codes():
    merged = bm.load_merged(bm.DEFAULT_PATHS["merged"])
    return sorted(set(merged["cbsa_code"].astype(str)))


# the rate a reader is shown: the permits_per_1000 accessor in
# web/src/lib/metrics.ts, units times a thousand over the population of the
# same panel, null where one side is inherited from a parent and the other is
# not, or where the population is not positive
def shown_rate(metro, period):
    inherited = metro.get("parent_metrics") or []
    if ("permits_units" in inherited) != ("pop_estimate" in inherited):
        return None
    values = metro["latest"] if period == "latest" else metro["years"][period]
    # as the accessor does: a panel carrying permits_footprint withholds its rate
    if values.get("permits_footprint") is not None:
        return None
    units, people = values.get("permits_units"), values.get("pop_estimate")
    if units is None or people is None or people <= 0:
        return None
    return units * 1000 / people


# the collector keeps the levels each vintage printed rather than rebase pep's
# 2010 base series onto the 2020 count, so every change measured across the
# two vintages is withheld where it is derived. the levels stand and no growth
# across the seam reaches the model
def seam_growth():
    pop = published_population()
    frame = pd.DataFrame([{"cbsa_code": c, "year": y, "value": v} for (c, y), v in pop.items()])
    return loop_panel.within_one_vintage(loop_panel.annual_log_change(frame)).set_index(["cbsa_code", "year"])


class TestAPopulationSeriesDoesNotStepAcrossARedraw(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.pop = published_population()
        cls.old = county_sets(pep_counties(OLD_VINTAGE))
        cls.new = county_sets(pep_counties(NEW_VINTAGE))
        cls.growth = seam_growth() if loop_panel is not None else None

    # the premise, read off pep's own county rows
    def test_the_two_files_give_these_codes_different_counties(self):
        self.assertEqual(self.old[SALISBURY] - self.new[SALISBURY], {SUSSEX_DE, WORCESTER_MD})
        self.assertEqual(self.new[SALISBURY] - self.old[SALISBURY], set())
        self.assertEqual((self.old[NEW_HAVEN], self.new[NEW_HAVEN]), ({NEW_HAVEN_COUNTY}, {SOUTH_CENTRAL_REGION}))
        self.assertEqual(self.new[BEND] - self.old[BEND], {CROOK, JEFFERSON})

    # the levels stand as each vintage printed them
    def test_both_sides_of_the_seam_are_published(self):
        for code in (SALISBURY, NEW_HAVEN, BEND):
            self.assertIn((code, SEAM - 1), self.pop)
            self.assertIn((code, SEAM), self.pop)

    @needs_loop
    def test_no_growth_across_the_redraw_reaches_the_model(self):
        for code in (SALISBURY, NEW_HAVEN, BEND):
            with self.subTest(code=code):
                row = self.growth.loc[(code, SEAM)]
                self.assertTrue(bool(row["withheld"]) and math.isnan(row["value"]),
                                f"{code} carries a {SEAM} growth of {row['value']} across two county sets")

    @needs_loop
    def test_no_study_metro_carries_a_growth_across_the_seam(self):
        at_seam = self.growth.xs(SEAM, level="year")
        carried = at_seam[at_seam["value"].notna()]
        self.assertEqual(list(carried.index), [], f"{len(carried)} metros carry a {SEAM} growth across the vintages")


class TestAPopulationSeriesDoesNotStepAcrossACensus(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.pop = published_population()
        old = county_sets(pep_counties(OLD_VINTAGE))
        new = county_sets(pep_counties(NEW_VINTAGE))
        cls.held = [c for c in study_codes() if c in old and c in new and old[c] == new[c]]
        cls.growth = seam_growth() if loop_panel is not None else None

    # the premise: abilene is callahan, jones and taylor in both files
    def test_abilene_kept_its_counties(self):
        self.assertIn(ABILENE, self.held)

    # a metro that kept its counties still steps across two census bases, so
    # its seam growth is withheld too, and the years either side are its own
    @needs_loop
    def test_abilene_does_not_grow_four_years_in_one(self):
        self.assertTrue(math.isnan(self.growth.loc[(ABILENE, SEAM), "value"]))
        for year in (SEAM - 1, SEAM + 1):
            self.assertAlmostEqual(self.growth.loc[(ABILENE, year), "value"], log_step(self.pop, ABILENE, year), places=12)

    @needs_loop
    def test_the_seam_is_as_quiet_as_any_other_year_where_no_county_moved(self):
        at_seam = self.growth.xs(SEAM, level="year").reindex(self.held)
        self.assertEqual(int(at_seam["value"].notna().sum()), 0)


# the map divides a year panel's permits by the same
# panel's population in the browser, and the 2014 panel holds permits bps
# counted on the february 2013 delineation over a population pep totals on
# the september 2018 one. where omb moved a county between the two, the
# numerator and the denominator count different places, so the rate has to
# be withheld or count one place
class TestTheMap2014PermitRateCountsOnePlace(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        payload = json.loads((bm.WEB_DATA_DIR / "metros.json").read_text())
        cls.metros = {metro["cbsa"]: metro for metro in payload["metros"]}
        cls.membership = bm.load_membership(bm.DEFAULT_PATHS["membership"])
        cls.people = county_population(pep_counties(OLD_VINTAGE), 2014)

    # the premise. dayton was 19380 until the september 2018 delineation made
    # it 19430, so the file a code is printed in says which delineation it is
    # on. pep's vintage 2019 prints the september 2018 counties for every code
    def test_bps_2014_and_pep_2014_are_on_different_delineations(self):
        self.assertIn("19380", printed_codes(2014))
        self.assertNotIn("19430", printed_codes(2014))
        sets = county_sets(pep_counties(OLD_VINTAGE))
        self.assertEqual({c: s for c, s in sets.items() if c in self.membership[SEPT_2018]},
                         {c: self.membership[SEPT_2018][c] for c in sets if c in self.membership[SEPT_2018]})
        self.assertEqual(self.membership[SEPT_2018][JACKSON_TN] - self.membership[FEB_2013][JACKSON_TN], {GIBSON})

    # 205 units over three counties divided by 179,358 people in four
    def test_jackson_2014_is_its_permits_over_the_people_of_the_same_counties(self):
        shown = shown_rate(self.metros[JACKSON_TN], "2014")
        self.assertTrue(shown is None or abs(shown / JACKSON_2014 - 1) <= SAME_RATE,
                        f"jackson tn 2014 shows {'none' if shown is None else f'{shown:.3f}'} per 1,000, its permits over the people of the "
                        f"same three counties are {JACKSON_2014:.3f}")

    # every study metro whose two 2014 footprints differ by more than the
    # footprint tolerance, weighed with pep's own 2014 county estimates
    def test_no_2014_rate_divides_permits_by_the_people_of_other_counties(self):
        wrong = []
        for code, metro in sorted(self.metros.items()):
            shown = shown_rate(metro, "2014")
            permits = self.membership[FEB_2013].get(code)
            people = self.membership[SEPT_2018].get(code)
            if shown is None or permits is None or people is None or permits == people:
                continue
            if any(f not in self.people for f in permits | people):
                continue
            share = (sum(self.people[f] for f in people - permits)
                     + sum(self.people[f] for f in permits - people)) / sum(self.people[f] for f in permits)
            right = metro["years"]["2014"]["permits_units"] * 1000 / sum(self.people[f] for f in permits)
            if share > bm.FOOTPRINT_TOLERANCE and abs(shown / right - 1) > SAME_RATE:
                wrong.append(f"{code} {metro['name']} shows {shown:.2f}, same counties {right:.2f}")
        self.assertEqual(wrong, [], f"{len(wrong)} 2014 rates over two footprints")

    # the control: salisbury held its four counties across both delineations,
    # so its 2014 rate is already one place and has to stay
    def test_a_metro_that_kept_its_counties_keeps_its_2014_rate(self):
        self.assertEqual(self.membership[FEB_2013][SALISBURY], self.membership[SEPT_2018][SALISBURY])
        self.assertAlmostEqual(shown_rate(self.metros[SALISBURY], "2014"), SALISBURY_2014, places=6)


# omb renumbered metros and divisions without moving a
# county under them, and the census download follows the renumbering through
# the two crosswalks. the pep and bps collectors have to follow it too, or a
# year published under the retired code never reaches the code the map and
# the panel carry
class TestARenumberedMetroKeepsItsYears(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.pop = published_population()
        cls.permits = published_permits()
        cls.membership = bm.load_membership(bm.DEFAULT_PATHS["membership"])
        cls.old = county_sets(pep_counties(OLD_VINTAGE))
        payload = json.loads((bm.WEB_DATA_DIR / "metros.json").read_text())
        cls.metros = {metro["cbsa"]: metro for metro in payload["metros"]}

    # the premise, from the delineations and from pep's own county rows
    def test_the_villages_is_sumter_county_under_both_codes(self):
        self.assertEqual(dc.MSA_CROSSWALK[THE_VILLAGES_OLD], THE_VILLAGES)
        for vintage in (FEB_2013, SEPT_2018):
            self.assertEqual(self.membership[vintage][THE_VILLAGES_OLD], {SUMTER})
        self.assertEqual(self.membership[JULY_2023][THE_VILLAGES], {SUMTER})
        self.assertEqual(self.old[THE_VILLAGES_OLD], {SUMTER})

    def test_pep_carries_the_villages_2014_and_2019_under_its_current_code(self):
        got = {year: self.pop.get((THE_VILLAGES, year)) for year in VILLAGES_POP}
        for year, expected in VILLAGES_POP.items():
            self.assertIsNotNone(got[year], f"{THE_VILLAGES} has no {year} population, "
                                            f"{self.pop.get((THE_VILLAGES_OLD, year))} sits under {THE_VILLAGES_OLD}")
            # the vintage 2019 figure, give or take a rebuild onto the 2020 base
            self.assertAlmostEqual(got[year], expected, delta=0.05 * expected)

    def test_bps_carries_the_villages_2014_and_2019_under_its_current_code(self):
        got = {year: self.permits.get((THE_VILLAGES, year)) for year in VILLAGES_PERMITS}
        self.assertEqual(got, VILLAGES_PERMITS,
                         f"{THE_VILLAGES_OLD} holds {[self.permits.get((THE_VILLAGES_OLD, y)) for y in VILLAGES_PERMITS]}")

    def test_the_map_shows_the_villages_in_2014_and_2019(self):
        years = self.metros[THE_VILLAGES]["years"]
        shown = {year: (years[str(year)]["pop_estimate"], years[str(year)]["permits_units"]) for year in VILLAGES_POP}
        self.assertTrue(all(None not in pair for pair in shown.values()),
                        f"population and permits by year: {shown}")

    # every pair the census download crosswalks, in each source year whose
    # delineation gave the old code the counties the new code holds today.
    # cleveland is not one: 17410 also holds ashtabula, and whether that move
    # may be reported is the footprint guard's question
    def test_no_same_county_renumbering_strands_a_year_under_the_retired_code(self):
        stranded = []
        for old, new in sorted({**dc.MSA_CROSSWALK, **dc.DIVISION_CROSSWALK}.items()):
            today = self.membership[JULY_2023].get(new)
            if self.old.get(old) == today:
                lost = sorted(y for c, y in self.pop if c == old and (new, y) not in self.pop)
                if lost:
                    stranded.append(f"pep {old}->{new} {lost[0]}-{lost[-1]}")
            lost = sorted(y for c, y in self.permits
                          if c == old and self.membership[bps_delineation(y)].get(old) == today
                          and (new, y) not in self.permits)
            if lost:
                stranded.append(f"bps {old}->{new} {lost[0]}-{lost[-1]}")
        self.assertEqual(stranded, [])


if __name__ == "__main__":
    unittest.main()

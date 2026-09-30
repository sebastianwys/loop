# a red test. run_tests.py discovers test*.py, so this one runs on its own:
#   .venv/bin/python -m unittest tests.redtest_panel_seams -v

import functools
import unittest

import numpy as np
import pandas as pd
import torch

from loop import nets, panel, spec

# loop.panel puts the repo root on the path for the map's helpers, and the
# footprint rule the map settled on lives beside them
from bot.build_map_data import FOOTPRINT_TOLERANCE, load_membership  # noqa: E402

PEP_DIR = spec.RAW_DIR / "pep"
BPS_DIR = spec.RAW_DIR / "bps"
MEMBERSHIP = spec.RAW_DIR / "gazetteer" / "cbsa_counties_by_vintage.csv"
SHIPPED_MODEL = spec.MODELS_DIR / "seqgru.pt"
COUNTY = "County or equivalent"

# an annual value for year y is known from the first quarter of y + 1, so the
# 2020 figure is what these four quarters read. 2020 is the first year of pep's
# vintage 2025, and 2019 the last of its vintage 2019
SEAM_QUARTERS = ["2021Q1", "2021Q2", "2021Q3", "2021Q4"]
BEFORE, AFTER = "2020Q4", "2022Q1"

SALISBURY, NEW_HAVEN = "41540", "35300"
# a growth rate this far from the metro's own growth either side of it is a
# redraw: the census closure alone never takes a study metro past 0.075
REDRAW = 0.10
# the share of metros past three percent that no ordinary year comes near
PAST = 0.03

# the vintage keys cbsa_counties_by_vintage files each delineation under
FEB_2013, SEPT_2018, JULY_2023 = "2014", "2019", "2024"

# bps counted 5,552 units in 2021 over sussex de, somerset, wicomico and
# worcester, the four counties its 2021 file gives salisbury, and pep's own
# 2021 estimate for those four is 429,446
SALISBURY_2021 = 5_552 * 1000 / 429_446
# a rate within this share of the one over the permit counties is that rate
SAME_RATE = 0.02


@functools.lru_cache(maxsize=None)
def built():
    return panel.build()


# the delineation each source year is published on. bps filed 2014 to 2018 on
# february 2013, 2019 to 2023 on september 2018 and 2024 on july 2023; pep's
# vintage 2019 is september 2018 and its vintage 2025 july 2023
def bps_delineation(year):
    return FEB_2013 if year <= 2018 else SEPT_2018 if year <= 2023 else JULY_2023


def pep_delineation(year):
    return SEPT_2018 if year <= 2019 else JULY_2023


def pep_counties(vintage):
    frame = pd.read_csv(PEP_DIR / f"cbsa-est{vintage}-alldata.csv", dtype=str, encoding="latin-1",
                        keep_default_na=False)
    rows = frame[frame["LSAD"].str.strip() == COUNTY]
    return rows.assign(STCOU=rows["STCOU"].str.strip().str.zfill(5)).drop_duplicates("STCOU")


# pep prints every county inside the areas it totals, so the counties behind
# a code in a vintage are read off that vintage itself
def county_sets(rows):
    out = {}
    for column in ("CBSA", "MDIV"):
        code = rows[column].str.strip()
        keyed = rows[code != ""]
        for key, group in keyed.groupby(code[code != ""].str.zfill(5)):
            out[key] = frozenset(group["STCOU"])
    return out


# the codes a bps annual prints, read off the publisher's file
def printed_codes(name):
    text = (BPS_DIR / name).read_bytes().decode("latin-1")
    return {fields[2].strip() for fields in (line.split(",") for line in text.splitlines()) if len(fields) > 2}


def value_at(series, code, quarter):
    value = series.get((code, quarter))
    return None if value is None or np.isnan(value) else float(value)


# the scale the shipped refit standardizes pop_growth by: the moments over
# every window with a realized outcome, which is what train_one fits on when
# forecast_models hands it every realized target
def shipped_scale(frame):
    windows = nets.build_windows(frame)
    realized = ~np.isnan(windows.y).all(axis=1)
    stats = nets.feature_stats(windows, realized)
    i = nets.STATIC_FEATURES.index("pop_growth")
    return bool(stats["static_seen"][i]), float(stats["static_std"][i])


# pop_growth for 2020 is the log ratio of vintage 2025's
# 2020 over vintage 2019's 2019, and those are two different delineations on
# two different census bases. the panel refuses exactly this at the division
# seam (test_the_derived_growth_never_crosses_the_seam), and not here
class TestPopulationGrowthNeverSpansTheVintageSeam(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.frame = built()
        cls.growth = cls.frame.set_index(spec.KEY)["pop_growth"]

    def assertNoSeam(self, code):
        around = [v for v in (value_at(self.growth, code, BEFORE), value_at(self.growth, code, AFTER)) if v is not None]
        for quarter in SEAM_QUARTERS:
            value = value_at(self.growth, code, quarter)
            self.assertTrue(value is None or not around or abs(value - sum(around) / len(around)) <= REDRAW,
                            f"{code} {quarter} reads pop_growth {'none' if value is None else f'{value:+.4f}'}, against "
                            f"{value_at(self.growth, code, BEFORE)} at {BEFORE} and "
                            f"{value_at(self.growth, code, AFTER)} at {AFTER}")

    # four counties with 415,726 people in 2019, two with 128,134 in 2020
    def test_salisbury_does_not_read_minus_118_percent(self):
        self.assertNoSeam(SALISBURY)

    # new haven county in 2019, the south central planning region in 2020
    def test_new_haven_does_not_read_minus_41_percent(self):
        self.assertNoSeam(NEW_HAVEN)

    # every other year has 3 to 17 metros past three percent
    def test_the_2020_growth_is_spread_like_any_other_year(self):
        first = self.frame[self.frame["quarter"].str.endswith("Q1")]
        past = first.groupby("quarter")["pop_growth"].apply(lambda s: int((s.abs() > PAST).sum()))
        seam, others = int(past.get(SEAM_QUARTERS[0], 0)), past.drop(SEAM_QUARTERS[0])
        read = int(first.loc[first["quarter"] == SEAM_QUARTERS[0], "pop_growth"].notna().sum())
        self.assertLessEqual(seam, 2 * int(others.max()),
                             f"{seam} of {read} metros read a 2020 growth past {PAST:.0%}, no other year "
                             f"more than {int(others.max())}")


# the same finding, where it reaches a model. pop_growth is one of the four
# annual inputs the shipped gru reads, and the shipped refit fits on every
# realized window, the four seam quarters included, so the seam sets the scale
# every metro's population growth is divided by, the 2026Q2 origin included
class TestTheSeamDoesNotSetTheShippedPopulationScale(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frame = built()
        cls.seen, cls.as_built = shipped_scale(frame)
        blank = frame.copy()
        blank.loc[blank["quarter"].isin(SEAM_QUARTERS), "pop_growth"] = np.nan
        _, cls.without_seam = shipped_scale(blank)

    # the premise: the shipped refit reads the column at all
    def test_the_shipped_gru_reads_population_growth(self):
        self.assertIn("pop_growth", spec.STATIC_FEATURES)
        self.assertTrue(self.seen)

    def test_the_seam_does_not_set_the_scale(self):
        self.assertLess(self.as_built / self.without_seam, 1.5,
                        f"pop_growth std over the shipped windows is {self.as_built:.5f}, "
                        f"{self.without_seam:.5f} with the four seam quarters left out")

    # the model that wrote forecasts.csv, not a refit of it. models/ is not
    # tracked, so a fresh clone skips this
    @unittest.skipUnless(SHIPPED_MODEL.exists(), "ml/models/seqgru.pt is not on disk")
    def test_the_model_that_wrote_the_forecast_was_not_scaled_by_the_seam(self):
        stats = torch.load(SHIPPED_MODEL, map_location="cpu", weights_only=False)["stats"]
        std = float(np.asarray(stats["static_std"])[nets.STATIC_FEATURES.index("pop_growth")])
        self.assertLess(std / self.without_seam, 1.5,
                        f"{SHIPPED_MODEL.name} standardizes pop_growth by {std:.5f}, "
                        f"{self.without_seam:.5f} without the seam")


# enrichment_features divides permits_units by
# pop_estimate on code and year, and the two sources change delineation in
# different years: bps at 2019 and 2024, pep at 2020. from 2014 to 2018 and
# from 2020 to 2023 the permits are counted over one set of counties and the
# people over another wherever omb moved a county in between
class TestPermitsPerThousandDividesOnePlace(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        frame = built()
        cls.rate = frame.set_index(spec.KEY)["permits_per_1000"]
        cls.msas = sorted(frame.loc[frame["level"] == "msa", "cbsa_code"].unique())
        cls.membership = load_membership(MEMBERSHIP)
        cls.old, cls.new = pep_counties(2019), pep_counties(2025)
        permits = pd.read_csv(BPS_DIR / "metrics.csv", dtype={"cbsa_code": str, "period": str})
        permits = permits[permits["metric"] == "permits_units"]
        cls.units = {(c, int(p)): float(v) for c, p, v in zip(permits["cbsa_code"], permits["period"], permits["value"])}

    def people(self, year):
        rows = self.old if year <= 2019 else self.new
        return dict(zip(rows["STCOU"], pd.to_numeric(rows[f"POPESTIMATE{year}"], errors="coerce").astype(float)))

    # the premise, read off the publishers' files: dayton was 19380 until the
    # september 2018 delineation made it 19430 and the villages was 45540
    # until july 2023 made it 48680, and pep prints each delineation's
    # counties county for county
    def test_each_source_year_is_on_the_delineation_this_test_assumes(self):
        self.assertTrue({"19380"} <= printed_codes("ma2018a.txt") and "19430" not in printed_codes("ma2018a.txt"))
        self.assertTrue({"19430"} <= printed_codes("ma2019a.txt") and "19380" not in printed_codes("ma2019a.txt"))
        self.assertTrue({"45540"} <= printed_codes("ma2023a.txt") and "48680" not in printed_codes("ma2023a.txt"))
        self.assertTrue({"48680"} <= printed_codes("cbsa2024a.txt") and "45540" not in printed_codes("cbsa2024a.txt"))
        for rows, key in ((self.old, SEPT_2018), (self.new, JULY_2023)):
            sets = county_sets(rows)
            shared = sorted(set(sets) & set(self.membership[key]))
            self.assertEqual([c for c in shared if sets[c] != self.membership[key][c]], [])

    # 5,552 units over four counties divided by 128,168 people in two of them.
    # read at 2022Q2: bps posts its annual files in may, so the lag
    # table (spec.PUBLISHED_IN_QUARTER, 2026-09-29) reads 2021 permits from
    # there. this test was written under the old one quarter rule
    def test_salisbury_2021_is_its_permits_over_the_people_of_the_same_counties(self):
        shown = value_at(self.rate, SALISBURY, "2022Q2")
        self.assertTrue(shown is None or abs(shown / SALISBURY_2021 - 1) <= SAME_RATE,
                        f"salisbury permits_per_1000 at 2022Q2 is {'none' if shown is None else f'{shown:.3f}'}, its 2021 permits over the "
                        f"people of the same four counties are {SALISBURY_2021:.3f}")

    # every study metro-year whose two footprints differ by more than the
    # footprint tolerance, weighed with pep's own county estimates for the year
    def test_no_study_metro_divides_permits_by_the_people_of_other_counties(self):
        wrong = []
        for year in range(2014, 2026):
            people = self.people(year)
            for code in self.msas:
                shown = value_at(self.rate, code, f"{year + 1}Q2")
                counted = self.membership[bps_delineation(year)].get(code)
                living = self.membership[pep_delineation(year)].get(code)
                if shown is None or counted is None or living is None or counted == living:
                    continue
                if (code, year) not in self.units or any(f not in people for f in counted | living):
                    continue
                share = (sum(people[f] for f in living - counted)
                         + sum(people[f] for f in counted - living)) / sum(people[f] for f in counted)
                right = self.units[(code, year)] * 1000 / sum(people[f] for f in counted)
                if share > FOOTPRINT_TOLERANCE and abs(shown / right - 1) > SAME_RATE:
                    wrong.append((abs(shown / right - 1), f"{code} {year} {shown:.2f} vs {right:.2f}"))
        wrong.sort(reverse=True)
        self.assertEqual(len(wrong), 0,
                         f"{len(wrong)} metro-years over {len({w[1][:5] for w in wrong})} metros, worst: "
                         + "; ".join(w[1] for w in wrong[:8]))


if __name__ == "__main__":
    unittest.main()

# run: ml/.venv/bin/python -m unittest tests.redtest_published_statistics -v

import math
import re
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "docs" / "REPORT.md"
MERGED = ROOT / "data" / "integrated" / "hpi_census_merged.csv"
CENSUS = ROOT / "data" / "raw" / "census"


# two-sided tail of the standard normal, so nothing here needs scipy
def normal_two_sided_p(z):
    return math.erfc(abs(z) / math.sqrt(2.0))


def fisher(r):
    return 0.5 * math.log((1.0 + r) / (1.0 - r))


# the test the report publishes. it assumes the two correlations came from two
# samples that share no rows, so each contributes its own 1/(n-3) of variance
def independent_sample_z(r_one, r_two, n_one, n_two):
    return (fisher(r_one) - fisher(r_two)) / math.sqrt(1.0 / (n_one - 3) + 1.0 / (n_two - 3))


# olkin's asymptotic covariance of two correlations measured on one sample and
# sharing no variable. j,k is the first pair, h,m the second
def correlation_covariance(r_jk, r_hm, r_jh, r_jm, r_kh, r_km):
    return (
        0.5 * r_jk * r_hm * (r_jh ** 2 + r_jm ** 2 + r_kh ** 2 + r_km ** 2)
        + r_jh * r_km
        + r_jm * r_kh
        - (r_jk * r_jh * r_jm + r_jk * r_kh * r_km + r_hm * r_jh * r_kh + r_hm * r_jm * r_km)
    )


# steiger 1980 z2*, the paired counterpart of the published test. the average of
# the two correlations goes into the covariance term. of the two usual variants
# this is the conservative one, so if the verdict moves here it moves either way
def steiger_z(r_jk, r_hm, r_jh, r_jm, r_kh, r_km, n):
    r_bar = (r_jk + r_hm) / 2.0
    cov = correlation_covariance(r_bar, r_bar, r_jh, r_jm, r_kh, r_km) / (1.0 - r_bar ** 2) ** 2
    return (fisher(r_jk) - fisher(r_hm)) * math.sqrt(n - 3) / math.sqrt(2.0 - 2.0 * cov)


# dunn and clark 1969, the same statistic without the averaging step
def dunn_clark_z(r_jk, r_hm, r_jh, r_jm, r_kh, r_km, n):
    cov = correlation_covariance(r_jk, r_hm, r_jh, r_jm, r_kh, r_km) / (
        (1.0 - r_jk ** 2) * (1.0 - r_hm ** 2)
    )
    return (fisher(r_jk) - fisher(r_hm)) * math.sqrt(n - 3) / math.sqrt(2.0 - 2.0 * cov)


# resample metros, not observations: a draw takes a metro's 2019 pair and its
# 2024 pair together, which is what makes the interval a paired one
def paired_bootstrap(first, second, draws, seed, chunk=5000):
    n = first[0].size
    rng = np.random.default_rng(seed)
    parts = []
    for start in range(0, draws, chunk):
        idx = rng.integers(0, n, size=(min(chunk, draws - start), n))
        parts.append(_boot_r(first, idx) - _boot_r(second, idx))
    return np.concatenate(parts)


def _boot_r(pair, idx):
    x = pair[0][idx]
    y = pair[1][idx]
    xc = x - x.mean(axis=1, keepdims=True)
    yc = y - y.mean(axis=1, keepdims=True)
    return (xc * yc).sum(axis=1) / np.sqrt((xc ** 2).sum(axis=1) * (yc ** 2).sum(axis=1))


def report_text():
    return REPORT.read_text(encoding="utf-8")


# the row block under a pipe-table header, as a list of cell lists
def markdown_table(text, header):
    lines = text.splitlines()
    start = lines.index(header) + 2
    rows = []
    for line in lines[start:]:
        if not line.startswith("|"):
            break
        rows.append([cell.strip() for cell in line.strip("|").split("|")])
    return rows


# the report retires an older decoupling claim by publishing a significance test
# on two correlations that were measured on one and the same 392 metros. the
# published test is the independent-sample fisher z, which assumes they were
# not. population in 2019 and 2024 correlates at 0.998 and hpi at 0.905, so
# nearly all of the sampling error is common to both correlations and cancels,
# and ignoring that is what produces the large p the conclusion rests on.
#
# the constants below are the file's, not the report's: the correlations and the
# metro count are recomputed here, the verdict is read out of the prose. a
# deliberate recompute updates these in the same commit as the paragraph
class TestThePopulationClaimRestsOnAPairedTest(unittest.TestCase):
    METROS = 392
    PUBLISHED_R = {2014: 0.28, 2019: 0.32, 2024: 0.28}
    ALPHA = 0.05
    DRAWS = 50000
    SEED = 477
    NOISE_VERDICT = "not distinguishable from sampling noise"

    @classmethod
    def setUpClass(cls):
        for path in (MERGED, REPORT):
            if not path.exists():
                raise unittest.SkipTest(f"{path.name} is not in this checkout")
        frame = pd.read_csv(MERGED, dtype={"cbsa_code": str})
        wide = frame.pivot(
            index="cbsa_code", columns="year", values=["total_pop", "avg_index_nsa"]
        ).dropna()
        cls.wide = wide
        cls.n = len(wide)
        cls.pair = {
            year: (
                wide[("total_pop", year)].to_numpy(float),
                wide[("avg_index_nsa", year)].to_numpy(float),
            )
            for year in (2014, 2019, 2024)
        }
        cls.r = {year: float(np.corrcoef(*cls.pair[year])[0, 1]) for year in cls.pair}
        cross = np.corrcoef(
            np.vstack([cls.pair[2019][0], cls.pair[2019][1], cls.pair[2024][0], cls.pair[2024][1]])
        )
        cls.cross = dict(
            r_jh=cross[0, 2], r_jm=cross[0, 3], r_kh=cross[1, 2], r_km=cross[1, 3]
        )
        cls.claim = next(
            line for line in report_text().splitlines() if "392 metros" in line
        )

    def steiger(self):
        z = steiger_z(self.r[2019], self.r[2024], n=self.n, **self.cross)
        return z, normal_two_sided_p(z)

    # the premise. the two correlations the report compares are measured on one
    # sample of metros, so the comparison is paired
    def test_both_legs_are_measured_on_the_same_metros(self):
        codes = self.wide.index
        self.assertEqual(len(codes), self.METROS)
        for year in (2014, 2019, 2024):
            self.assertEqual(self.pair[year][0].size, self.METROS)
        self.assertTrue(codes.is_unique)

    def test_the_three_published_correlations_reproduce(self):
        self.assertEqual(
            {year: round(self.r[year], 2) for year in sorted(self.r)}, self.PUBLISHED_R
        )

    # every z the paragraph prints has to agree with the p printed beside it
    def test_each_published_z_carries_the_p_value_it_implies(self):
        printed = re.findall(r"z = ([\d.]+), p = ([\d.]+)", self.claim)
        self.assertEqual(len(printed), 1)
        z = independent_sample_z(self.r[2019], self.r[2024], self.n, self.n)
        self.assertEqual(
            (float(printed[0][0]), float(printed[0][1])),
            (round(z, 2), round(normal_two_sided_p(z), 2)),
            f"independent-sample fisher z recomputes to {z:.4f}, "
            f"whose two-sided p is {normal_two_sided_p(z):.4f}",
        )

    # the verdict in the prose has to be the verdict the paired test gives
    def test_the_published_verdict_is_the_one_steigers_paired_test_gives(self):
        z, p = self.steiger()
        alt = dunn_clark_z(self.r[2019], self.r[2024], n=self.n, **self.cross)
        naive = independent_sample_z(self.r[2019], self.r[2024], self.n, self.n)
        self.assertEqual(
            self.NOISE_VERDICT in self.claim,
            p >= self.ALPHA,
            f"steiger z = {z:.4f}, p = {p:.4f} on {self.n} paired metros "
            f"(dunn-clark z = {alt:.4f}, p = {normal_two_sided_p(alt):.4f}); "
            f"the published independent-sample z = {naive:.4f}, "
            f"p = {normal_two_sided_p(naive):.4f} discards the pairing",
        )

    # and the verdict a resampling test gives, which assumes no normality
    def test_the_published_verdict_is_the_one_the_paired_bootstrap_gives(self):
        diff = paired_bootstrap(self.pair[2019], self.pair[2024], self.DRAWS, self.SEED)
        low, high = np.percentile(diff, [2.5, 97.5])
        p = 2.0 * min((diff <= 0).mean(), (diff >= 0).mean())
        self.assertEqual(
            self.NOISE_VERDICT in self.claim,
            bool(low <= 0.0 <= high),
            f"{self.DRAWS} paired draws put the 2019 minus 2024 correlation gap at "
            f"{self.r[2019] - self.r[2024]:.4f}, 95 percent CI "
            f"[{low:.4f}, {high:.4f}], p = {p:.4f}",
        )


# the vintage table publishes a row count for each committed acs file. the three
# numbers are the msa rows only, taken before the 31, 31 and 37 division rows
# that the same report's problem 5 describes adding
class TestThePublishedAcsRowCountsMatchTheFiles(unittest.TestCase):
    VINTAGES = (2014, 2019, 2024)
    FILE_ROWS = {2014: 960, 2019: 969, 2024: 972}
    MSA_ROWS = {2014: 929, 2019: 938, 2024: 935}
    DIVISION_ROWS = {2014: 31, 2019: 31, 2024: 37}
    TABLE_HEADER = "| vintage | window | role | rows |"

    @classmethod
    def setUpClass(cls):
        if not REPORT.exists():
            raise unittest.SkipTest("REPORT.md is not in this checkout")
        for year in cls.VINTAGES:
            if not (CENSUS / f"acs_5yr_{year}.csv").exists():
                raise unittest.SkipTest(f"acs_5yr_{year}.csv is not in this checkout")
        cls.files = {
            year: pd.read_csv(CENSUS / f"acs_5yr_{year}.csv", dtype=str) for year in cls.VINTAGES
        }
        cls.manifest = pd.read_json(CENSUS / "download_manifest.json")
        cls.published = {
            int(row[0]): int(row[-1])
            for row in markdown_table(report_text(), cls.TABLE_HEADER)
        }

    def test_the_committed_files_hold_the_pinned_row_counts(self):
        self.assertEqual({year: len(self.files[year]) for year in self.VINTAGES}, self.FILE_ROWS)

    # the files and their own manifest agree, so the report is the odd one out
    def test_the_manifest_records_the_row_count_each_file_holds(self):
        recorded = {
            int(row["version"].split()[-1]): int(row["integrity"]["row_count"])
            for _, row in self.manifest.iterrows()
        }
        self.assertEqual(recorded, self.FILE_ROWS)

    def test_the_report_publishes_the_row_count_each_file_holds(self):
        self.assertEqual(
            self.published,
            self.FILE_ROWS,
            "the vintage table in docs/REPORT.md is short by the division rows "
            f"{self.DIVISION_ROWS}",
        )

    # names the cause: the published figures are the msa rows on their own
    def test_the_msa_rows_alone_are_what_the_report_publishes(self):
        msa_only = {
            year: int((self.files[year]["geo_level"] == "msa").sum()) for year in self.VINTAGES
        }
        self.assertEqual(msa_only, self.MSA_ROWS)
        for year in self.VINTAGES:
            divisions = int((self.files[year]["geo_level"] == "division").sum())
            self.assertEqual(divisions, self.DIVISION_ROWS[year])
            self.assertEqual(msa_only[year] + divisions, self.FILE_ROWS[year])


if __name__ == "__main__":
    unittest.main()

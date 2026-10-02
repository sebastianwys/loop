import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "docs" / "REPORT.md"
MERGED = ROOT / "data" / "integrated" / "hpi_census_merged.csv"
CENSUS = ROOT / "data" / "raw" / "census"


def report_text():
    return REPORT.read_text(encoding="utf-8")


# the row block under a pipe table header, as a list of cell lists
def markdown_table(text, header):
    lines = text.splitlines()
    start = lines.index(header) + 2
    rows = []
    for line in lines[start:]:
        if not line.startswith("|"):
            break
        rows.append([cell.strip() for cell in line.strip("|").split("|")])
    return rows


# the report's population paragraph rests on the correlation of population
# with the price index, on the metros that carry all three vintages. the
# constants are the report's numbers, recomputed here from the merged csv
class TestThePublishedCorrelationsReproduce(unittest.TestCase):
    METROS = 396
    PUBLISHED_R = {2014: 0.27, 2019: 0.31, 2024: 0.27}

    @classmethod
    def setUpClass(cls):
        if not MERGED.exists():
            raise unittest.SkipTest(f"{MERGED.name} is not in this checkout")
        frame = pd.read_csv(MERGED, dtype={"cbsa_code": str})
        wide = frame.pivot(
            index="cbsa_code", columns="year", values=["total_pop", "avg_index_nsa"]
        ).dropna()
        cls.wide = wide
        cls.pair = {
            year: (
                wide[("total_pop", year)].to_numpy(float),
                wide[("avg_index_nsa", year)].to_numpy(float),
            )
            for year in (2014, 2019, 2024)
        }
        cls.r = {year: float(np.corrcoef(*cls.pair[year])[0, 1]) for year in cls.pair}

    # the three correlations are measured on one sample of metros, so any
    # comparison of them is a paired one
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


# the report's vintage table publishes a row count for each committed acs
# file, its msa rows and its division rows together
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

    # the files and their own manifest agree
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
            "the vintage table in docs/REPORT.md does not match the committed acs files",
        )

    # each file is its msa rows plus its division rows
    def test_the_msa_and_division_rows_make_up_each_file(self):
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

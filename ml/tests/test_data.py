import csv
import io
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from loop import data


# milestone 1. the integrated file is the one thing every later step is pinned
# to, and its identity lived in three documents and no assertion until now
class TestLoadTheRealFile(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not data.PATH.exists():
            raise unittest.SkipTest(f"{data.PATH.name} is not in this checkout")
        cls.frame = data.load()

    def test_the_published_shape(self):
        data.check_shape(self.frame)
        self.assertEqual(len(self.frame), 1204)
        self.assertEqual(self.frame["cbsa_code"].nunique(), 410)
        self.assertEqual(sorted(int(y) for y in self.frame["year"].unique()), [2014, 2019, 2024])

    # a code read as a number is the bug that put 16980.0 in a blank
    # parent_cbsa and stopped a join matching
    def test_codes_are_strings_and_a_blank_stays_blank(self):
        self.assertEqual(self.frame["cbsa_code"].iloc[0], "10180")
        self.assertTrue(self.frame["cbsa_code"].map(lambda c: isinstance(c, str)).all())
        msa = self.frame[self.frame["geo_level"] == "msa"]
        self.assertEqual(set(msa["parent_cbsa"]), {""})
        division = self.frame[self.frame["geo_level"] == "division"]
        self.assertTrue(division["parent_cbsa"].str.fullmatch(r"\d{5}").all())

    def test_the_numbers_are_numbers(self):
        for column in ("avg_index_nsa", "median_income", "total_pop", "median_home_value", "homeownership_rate"):
            self.assertTrue(pd.api.types.is_numeric_dtype(self.frame[column]), column)
        self.assertTrue(pd.api.types.is_integer_dtype(self.frame["year"]))

    def test_the_two_constant_columns_are_gone(self):
        self.assertNotIn("hpi_type", self.frame.columns)
        self.assertNotIn("hpi_flavor", self.frame.columns)
        self.assertEqual(len(self.frame.columns), 22)

    def test_the_columns_every_later_step_reads(self):
        for column in ("place_id", "place_name", "cbsa_code", "year", "avg_index_nsa", "median_income",
                       "total_pop", "median_age", "adults_25_plus", "bachelors_count", "masters_count",
                       "median_home_value", "homeownership_rate", "geo_level", "parent_cbsa", "NAME"):
            self.assertIn(column, self.frame.columns)

    def test_no_metro_repeats_a_year(self):
        self.assertFalse(self.frame.duplicated(["cbsa_code", "year"]).any())


class TestATamperedFileRaises(unittest.TestCase):
    def setUp(self):
        if not data.PATH.exists():
            raise unittest.SkipTest(f"{data.PATH.name} is not in this checkout")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.copy = Path(self.tmp.name) / "hpi_census_merged.csv"

    def tamper(self, text):
        self.copy.write_text(text)
        return self.copy

    # one cell changed is a different dataset, and the whole point is that it
    # cannot reach a model quietly
    def test_one_population_moved_by_one_is_refused(self):
        rows = list(csv.reader(data.PATH.read_text().splitlines()))
        column = rows[0].index("total_pop")
        rows[1][column] = str(int(rows[1][column]) + 1)
        buffer = io.StringIO()
        csv.writer(buffer, lineterminator="\n").writerows(rows)
        with self.assertRaises(ValueError) as caught:
            data.load(self.tamper(buffer.getvalue()))
        self.assertIn("not the published file", str(caught.exception))

    # a byte that changes nothing a reader would see still changes the file
    def test_a_trailing_byte_is_refused(self):
        with self.assertRaises(ValueError):
            data.load(self.tamper(data.PATH.read_text() + "\n"))

    def test_the_message_names_both_hashes_short(self):
        with self.assertRaises(ValueError) as caught:
            data.load(self.tamper("a,b\n1,2\n"))
        message = str(caught.exception)
        self.assertIn(data.SHA256[:12], message)
        self.assertIn("loop.data", message)

    def test_a_missing_file_says_so_rather_than_hashing_nothing(self):
        with self.assertRaises(FileNotFoundError):
            data.load(Path(self.tmp.name) / "not_here.csv")

    # the escape hatch a test needs to build a frame that was never published.
    # every other caller gets the published file or an error
    def test_no_hash_asked_for_reads_whatever_is_there(self):
        frame = data.load(self.tamper("cbsa_code,year,total_pop\n10180,2014,100\n"), sha256=None)
        self.assertEqual(frame["cbsa_code"].tolist(), ["10180"])
        self.assertEqual(frame["total_pop"].tolist(), [100])

    def test_the_shape_check_names_which_half_failed(self):
        frame = data.load(self.tamper("cbsa_code,year,total_pop\n10180,2014,100\n"), sha256=None)
        with self.assertRaises(ValueError) as caught:
            data.check_shape(frame)
        self.assertIn("rows", str(caught.exception))

    # dropping a column that varies would hide information rather than noise
    def test_a_column_that_stops_being_constant_is_not_dropped_quietly(self):
        text = "cbsa_code,year,hpi_type,total_pop\n10180,2014,traditional,100\n10180,2019,purchase-only,200\n"
        with self.assertRaises(ValueError) as caught:
            data.load(self.tamper(text), sha256=None)
        self.assertIn("hpi_type", str(caught.exception))
        self.assertIn("not constant", str(caught.exception))

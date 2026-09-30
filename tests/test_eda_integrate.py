import contextlib
import hashlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless, the script writes png charts

import pandas as pd

SCRIPT = Path(__file__).parent.parent / "scripts" / "eda_integrate.py"

# census marks a suppressed estimate with this sentinel, not with a blank
SENTINEL = "-666666666"

FHFA_HEADER = "hpi_type,hpi_flavor,frequency,level,place_name,place_id,yr,period,index_nsa,index_sa,rstderr,note"
# the master file carries census-division rows with alphabetic place ids, which
# is why place_id reads as a string. the msa filter drops this row
NON_MSA_ROW = (
    "traditional,purchase-only,monthly,USA or Census Division,"
    "East North Central Division,DV_ENC,1991,1,100.00,100.00,,"
)
CENSUS_HEADER = (
    "NAME,B19013_001E,B01003_001E,B01002_001E,B15003_001E,B15003_022E,B15003_023E,"
    "B25003_001E,B25003_002E,B25077_001E,"
    "metropolitan statistical area/micropolitan statistical area,"
    "metropolitan division,geo_level,geo_code,parent_cbsa,year"
)


# scripts/ is not a package, so load the module straight off its path
def load_eda():
    spec = importlib.util.spec_from_file_location("eda_integrate", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def hpi_rows(place_id, place_name, year, index_nsa):
    return [
        f"traditional,all-transactions,quarterly,MSA,{place_name},{place_id},{year},{q},{index_nsa},,,"
        for q in (1, 2, 3, 4)
    ]


def census_row(code, name, year, income, occupied, owner):
    return (
        f'"{name}",{income},1000000,38.0,660000,50000,20000,{occupied},{owner},250000,'
        f"{code},,msa,{code},,{year}"
    )


class SuppressionSentinelTest(unittest.TestCase):
    # a row the census suppressed must carry no measurement into the merged file
    def test_suppressed_acs_estimates_are_null_in_integrated_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / "data"
            (data / "raw" / "fhfa").mkdir(parents=True)
            (data / "raw" / "census").mkdir(parents=True)

            (data / "raw" / "fhfa" / "hpi_master.csv").write_text(
                "\n".join(
                    [FHFA_HEADER, NON_MSA_ROW]
                    + hpi_rows("16980", "Chicago-Naperville-Elgin IL-IN-WI", 2024, "170.00")
                    + hpi_rows("10180", "Abilene TX", 2024, "150.00")
                )
                + "\n"
            )

            (data / "raw" / "census" / "acs_5yr_combined.csv").write_text(
                "\n".join(
                    [
                        CENSUS_HEADER,
                        census_row(
                            "16980",
                            "Chicago-Naperville-Elgin, IL-IN-WI Metro Area",
                            2024,
                            "80000",
                            "3600000",
                            "2304000",
                        ),
                        # abilene is suppressed: the api returned the sentinel
                        census_row("10180", "Abilene, TX Metro Area", 2024, SENTINEL, SENTINEL, SENTINEL),
                    ]
                )
                + "\n"
            )

            module = load_eda()
            module.DATA_DIR = data
            module.RESULTS_DIR = root / "results"

            with contextlib.redirect_stdout(io.StringIO()):
                module.main()

            merged = pd.read_csv(
                data / "integrated" / "hpi_census_merged.csv", dtype={"cbsa_code": str}
            )

            suppressed = merged[merged["cbsa_code"] == "10180"].iloc[0]
            for col in (
                "median_income",
                "total_occupied_units",
                "owner_occupied_units",
                "homeownership_rate",
            ):
                self.assertTrue(
                    pd.isna(suppressed[col]),
                    f"{col} for a suppressed metro should be NaN, got {suppressed[col]!r}",
                )

            # the unsuppressed metro is untouched
            clean = merged[merged["cbsa_code"] == "16980"].iloc[0]
            self.assertEqual(clean["median_income"], 80000.0)
            self.assertAlmostEqual(clean["homeownership_rate"], 0.64, places=6)


if __name__ == "__main__":
    unittest.main()


# every published result, every figure and the whole map are computed on one
# file, and its identity was written into three documents and into no assertion
# that runs. any of the pipeline's own failure modes changes it silently: the
# degree share denominator that joined on 2026-09-16 moved the hash, and both
# suites stayed green through it.
#
# loop.data.load, milestone 1 in ml/MILESTONES.md, checks the hash on read.
# this is the other half, the one that catches the drift today: it reads the
# real file and fails if the shape, the coverage or the bytes move
class TestTheIntegratedFileIsTheOneEverythingWasComputedOn(unittest.TestCase):
    PATH = Path(__file__).resolve().parent.parent / "data" / "integrated" / "hpi_census_merged.csv"
    SHA256 = "b65d953f4c6beed7266be7da74292c45917d4c2fa404ba6414c402610dc18deb"
    SHAPE = (1204, 24)
    METROS = 410
    YEARS = [2014, 2019, 2024]
    LEVELS = {"msa": 1108, "division": 96}

    @classmethod
    def setUpClass(cls):
        if not cls.PATH.exists():
            raise unittest.SkipTest(f"{cls.PATH.name} is not in this checkout")
        cls.frame = pd.read_csv(cls.PATH, dtype={"cbsa_code": str, "geo_level": str, "parent_cbsa": str})

    # the number quoted in ml/README.md. when the pipeline is
    # re-run on purpose, update it here in the same commit as the prose
    def test_the_bytes_are_the_ones_the_documents_name(self):
        self.assertEqual(hashlib.sha256(self.PATH.read_bytes()).hexdigest(), self.SHA256)

    def test_the_shape_and_the_coverage_are_the_published_ones(self):
        self.assertEqual(self.frame.shape, self.SHAPE)
        self.assertEqual(self.frame["cbsa_code"].nunique(), self.METROS)
        self.assertEqual(sorted(int(y) for y in self.frame["year"].unique()), self.YEARS)
        self.assertEqual(self.frame["geo_level"].value_counts().to_dict(), self.LEVELS)

    # the 13 split metros are why every fhfa code joins at all, so a rebuild
    # that quietly lost the division rows has to be loud
    def test_the_thirty_seven_divisions_are_all_present(self):
        divisions = self.frame[self.frame["geo_level"] == "division"]
        self.assertEqual(divisions["cbsa_code"].nunique(), 37)
        self.assertEqual(divisions["parent_cbsa"].nunique(), 13)

    # the columns downstream reads by name. a rename is a silent null in every
    # reader, which is exactly what the degree share denominator was
    def test_the_columns_downstream_reads_are_all_there(self):
        for column in ("place_id", "place_name", "cbsa_code", "year", "avg_index_nsa", "median_income",
                       "total_pop", "median_age", "adults_25_plus", "bachelors_count", "masters_count",
                       "median_home_value", "homeownership_rate", "geo_level", "parent_cbsa", "NAME"):
            self.assertIn(column, self.frame.columns)

    def test_no_metro_repeats_a_year(self):
        self.assertFalse(self.frame.duplicated(["cbsa_code", "year"]).any())

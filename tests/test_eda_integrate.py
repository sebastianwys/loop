import contextlib
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
    "NAME,B19013_001E,B01003_001E,B01002_001E,B15003_022E,B15003_023E,"
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
        f'"{name}",{income},1000000,38.0,50000,20000,{occupied},{owner},250000,'
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

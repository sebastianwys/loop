import json
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from loop import spec

# the panel's leakage rule, in panel.annual_as_of: "a row therefore never sees
# a number published after its quarter". an annual value for year y known
# from the first quarter of y + 1 fits the population estimates, which reach
# metros in march. it does not fit income. bot/collectors/bea.py sums bea's
# county personal income (cainc1) to every cbsa, and bea releases county
# personal income for year y in november of y + 1 at the earliest. so in the
# first three quarters of y + 1 the newest income growth anyone could have
# read is year y - 1's, and that is the only one the panel may hold there
#
# the archive records it for its own newest year: data/raw/bea/cainc1_line1.json
# carries bea's stamp "Last updated: February 5, 2026-- new statistics for
# 2024", so 2024 was unpublished through every quarter of 2025
#
# the shipped forecast reads 2024 at its 2026Q2 origin, which is on time, and
# the last test holds that

BEA = spec.RAW_DIR / "bea"
STAMP_2024 = "February 5, 2026-- new statistics for 2024"


# income growth per metro and year as the archive holds it, the log change of
# per capita income over the year before. rows are cbsa codes, columns years
def bea_growth():
    metrics = pd.read_csv(BEA / "metrics.csv", dtype={"cbsa_code": str, "metric": str, "period": str})
    rows = metrics[metrics["metric"] == "bea_income_per_capita"]
    wide = rows.assign(year=rows["period"].astype(int)).pivot(index="cbsa_code", columns="year", values="value")
    return np.log(wide.astype(float)).diff(axis=1)


def bea_stamps():
    payload = json.loads((BEA / "cainc1_line1.json").read_text())
    block = payload["BEAAPI"]["Results"]
    block = block[0] if isinstance(block, list) else block
    return " ".join(note.get("NoteText", "") for note in block.get("Notes", []))


def income_at(panel, code, quarters):
    rows = panel[panel["cbsa_code"] == code].set_index("quarter")["income_growth"]
    return [round(float(rows[q]), 6) for q in quarters]


# the cells of one quarter whose metro has a growth for `year` that differs
# from the year before, so holding it cannot be a tie, and the ones that hold it
def holding(panel, growth, quarter, year):
    cells = panel[panel["quarter"] == quarter].set_index("cbsa_code")["income_growth"]
    this, before = growth[year].dropna(), growth[year - 1]
    codes = cells.index.intersection(this.index)
    codes = codes[~np.isclose(this[codes], before.reindex(codes).fillna(np.inf))]
    held = codes[np.isclose(cells[codes].to_numpy(float), this[codes].to_numpy(float))]
    return len(codes), [(code, quarter) for code in held]


@unittest.skipUnless(Path(spec.PANEL_PATH).exists() and (BEA / "metrics.csv").exists(),
                     "ml/data/panel.parquet or the bea archive is not on disk")
class TestIncomeIsReadOnlyAfterBeaPublishedIt(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel = pd.read_parquet(spec.PANEL_PATH, columns=["cbsa_code", "quarter", "income_growth"])
        cls.growth = bea_growth()

    def growth_of(self, code, year):
        return round(float(self.growth.loc[code, year]), 6)

    # austin. bea released 2021 in november 2022, so through 2022Q3 the newest
    # published growth is 2020's, 0.024457. 2021's is 0.107356
    def test_austin_holds_2020_growth_until_bea_releases_2021(self):
        self.assertEqual(income_at(self.panel, "12420", ["2022Q1", "2022Q2", "2022Q3"]),
                         [self.growth_of("12420", 2020)] * 3)

    # the chicago division. bea released 2022 in november 2023, so through
    # 2023Q3 the newest published growth is 2021's, 0.079227. 2022's is 0.014042
    def test_chicago_division_holds_2021_growth_until_bea_releases_2022(self):
        self.assertEqual(income_at(self.panel, "16984", ["2023Q1", "2023Q2", "2023Q3"]),
                         [self.growth_of("16984", 2021)] * 3)

    # every metro and every year the archive carries
    def test_no_metro_holds_a_bea_year_in_the_first_three_quarters_after_it(self):
        checked, held = 0, []
        for year in self.growth.columns[1:]:
            for q in (1, 2, 3):
                n, hits = holding(self.panel, self.growth, f"{year + 1}Q{q}", year)
                checked += n
                held += hits
        self.assertGreater(checked, 10000)
        self.assertEqual(len(held), 0,
                         f"{len(held)} of {checked} metro quarters in y+1 Q1 to Q3 hold bea's year y, "
                         f"published in november of y+1 at the earliest, first {held[:3]}")

    # the archive's own stamp. 2024 came out on 2026-02-05, so it was not
    # published in any quarter of 2025, the newest origins the refit fits on
    def test_no_quarter_of_2025_holds_2024_which_bea_published_on_2026_02_05(self):
        if STAMP_2024 not in bea_stamps():
            self.skipTest("the bea archive no longer carries the 2024 release stamp")
        checked, held = 0, []
        for q in (1, 2, 3, 4):
            n, hits = holding(self.panel, self.growth, f"2025Q{q}", 2024)
            checked += n
            held += hits
        self.assertGreater(checked, 400)
        self.assertEqual(len(held), 0,
                         f"{len(held)} of {checked} metro quarters of 2025 hold bea's 2024, "
                         f"first published 2026-02-05, first {held[:3]}")

    # the control: the live origin reads 2024, which bea had published by the
    # end of 2026Q1, so the shipped forecast's own input is on time
    def test_the_2026q2_origin_reads_2024_which_bea_had_published(self):
        n, held = holding(self.panel, self.growth, "2026Q2", 2024)
        self.assertGreater(n, 400)
        self.assertEqual(len(held), n)


if __name__ == "__main__":
    unittest.main()

import unittest

import numpy as np
import pandas as pd

from bot.collectors import bls, fred, gazetteer

GAZ_TEXT = (
    "CSAFP\tGEOID\tNAME\tCBSA_TYPE\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG        \n"
    "101\t10180\tAbilene, TX Metro Area\t1\t7105669751\t36754978\t2743.515\t14.191\t32.452022\t-99.718743        \n"
    "\t10100\tAberdeen, SD Micro Area\t2\t1\t1\t1.0\t0.0\t45.5\t-98.5        \n"
)

# blank lines, a hyphenated multi-state name, puerto rico with no csa, all
# with the trailing spaces the real file carries
GAZ_EDGE_TEXT = (
    "CSAFP\tGEOID\tNAME\tCBSA_TYPE\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG        \n"
    "\n"
    "176\t16980\tChicago-Naperville-Elgin, IL-IN-WI Metro Area\t1\t1\t1\t1.0\t0.0\t41.8\t-87.9        \n"
    "   \n"
    "\t41980\tSan Juan-Bayamon-Caguas, PR Metro Area\t1\t1\t1\t1.0\t0.0\t18.3\t-66.1        \n"
    "\t10100\tAberdeen, SD Micro Area\t2\t1\t1\t1.0\t0.0\t45.5\t-98.5        \n"
)


class TestGazetteer(unittest.TestCase):
    # trailing spaces on every line are the trap in this file
    def test_parse_strips_and_types(self):
        df = gazetteer.parse_gazetteer(GAZ_TEXT)
        self.assertEqual(list(df.columns), ["cbsa_code", "name", "cbsa_type", "land_sqmi", "lat", "lon"])
        abilene = df[df.cbsa_code == "10180"].iloc[0]
        self.assertEqual(abilene["name"], "Abilene, TX Metro Area")
        self.assertAlmostEqual(abilene["lon"], -99.718743)
        self.assertEqual(int(abilene["cbsa_type"]), 1)

    def test_micro_areas_kept_with_type_two(self):
        df = gazetteer.parse_gazetteer(GAZ_TEXT)
        self.assertEqual(df[df.cbsa_code == "10100"].iloc[0]["cbsa_type"], 2)

    def test_header_trailing_whitespace_does_not_leak_into_columns(self):
        df = gazetteer.parse_gazetteer(GAZ_TEXT)
        self.assertFalse(any(c != c.strip() for c in df.columns))
        self.assertEqual(len(df), 2)

    def test_blank_lines_in_the_middle_are_skipped(self):
        df = gazetteer.parse_gazetteer(GAZ_EDGE_TEXT)
        self.assertEqual(df.cbsa_code.tolist(), ["16980", "41980", "10100"])

    def test_name_keeps_hyphens_and_comma(self):
        df = gazetteer.parse_gazetteer(GAZ_EDGE_TEXT)
        self.assertEqual(df[df.cbsa_code == "16980"].iloc[0]["name"],
                         "Chicago-Naperville-Elgin, IL-IN-WI Metro Area")

    def test_puerto_rico_row_without_csa(self):
        df = gazetteer.parse_gazetteer(GAZ_EDGE_TEXT)
        pr = df[df.cbsa_code == "41980"].iloc[0]
        self.assertEqual(pr["name"], "San Juan-Bayamon-Caguas, PR Metro Area")
        self.assertAlmostEqual(pr["lat"], 18.3)

    # every us metro is in the western hemisphere, and nothing is off the globe
    def test_longitudes_are_negative_and_on_the_globe(self):
        df = gazetteer.parse_gazetteer(GAZ_EDGE_TEXT)
        self.assertTrue((df.lon < 0).all())
        self.assertTrue(df.lon.between(-180, 180).all())
        self.assertTrue(df.lat.between(-90, 90).all())

    def test_cbsa_type_is_int_for_every_row(self):
        df = gazetteer.parse_gazetteer(GAZ_EDGE_TEXT)
        self.assertEqual(df.cbsa_type.dtype.kind, "i")
        for value in df.cbsa_type:
            self.assertIsInstance(value, (int, np.integer))


class TestBls(unittest.TestCase):
    # bls answers at most twenty years a query with a key and ten without, so
    # a pull that reaches 1990 has to be cut into windows that tile the range
    # with no year in two of them and no year missed
    def test_year_windows_tile_the_range_without_overlap(self):
        windows = bls.year_windows(1990, 2026, 20)
        self.assertEqual(windows, [(1990, 2009), (2010, 2026)])
        years = [y for first, last in windows for y in range(first, last + 1)]
        self.assertEqual(years, list(range(1990, 2027)))

    def test_year_windows_never_reach_past_the_end_year(self):
        for span in (5, 10, 20):
            windows = bls.year_windows(1990, 2026, span)
            self.assertEqual(windows[0][0], 1990)
            self.assertEqual(windows[-1][1], 2026)
            self.assertTrue(all(last - first + 1 <= span for first, last in windows))

    def test_a_single_year_range_is_one_window(self):
        self.assertEqual(bls.year_windows(2026, 2026, 20), [(2026, 2026)])

    # verified live: these three ids return data
    def test_series_id_matches_bls_scheme(self):
        self.assertEqual(bls.series_id("10180", "TX"), "LAUMT481018000000003")
        self.assertEqual(bls.series_id("16980", "IL"), "LAUMT171698000000003")
        self.assertEqual(bls.series_id("28140", "MO"), "LAUMT292814000000003")

    def test_series_id_is_always_twenty_chars(self):
        for code, state in (("10180", "TX"), ("16980", "IL"), ("41980", "PR"), ("10100", "SD")):
            self.assertEqual(len(bls.series_id(code, state)), 20)

    def test_series_id_zero_pads_state_fips(self):
        self.assertTrue(bls.series_id("10180", "AL").startswith("LAUMT01"))
        self.assertTrue(bls.series_id("10180", "AK").startswith("LAUMT02"))

    # an unknown abbreviation is a data problem, so a loud KeyError is intended
    def test_unknown_state_raises(self):
        with self.assertRaises(KeyError):
            bls.series_id("10180", "XX")

    def test_primary_state_is_the_first_listed(self):
        self.assertEqual(bls.primary_state("Chicago-Naperville-Elgin, IL-IN-WI Metro Area"), "IL")
        self.assertEqual(bls.primary_state("Abilene, TX Metro Area"), "TX")
        self.assertEqual(bls.primary_state("Washington-Arlington-Alexandria, DC-VA-MD-WV Metro Area"), "DC")

    def test_primary_state_puerto_rico_and_micro(self):
        self.assertEqual(bls.primary_state("San Juan-Bayamon-Caguas, PR Metro Area"), "PR")
        self.assertEqual(bls.primary_state("Aberdeen, SD Micro Area"), "SD")

    def test_parse_keeps_every_month_and_the_annual_average(self):
        series = [{"seriesID": "LAUMT481018000000003", "data": [
            {"year": "2024", "period": "M13", "value": "3.4"},
            {"year": "2024", "period": "M12", "value": "3.1"},
            {"year": "2025", "period": "M03", "value": "3.7"},
            {"year": "2025", "period": "M02", "value": "3.9"},
        ]}]
        df = bls.parse_series(series)
        self.assertEqual(df.cbsa_code.tolist(), ["10180"] * 4)
        self.assertEqual(df[df.period == "M13"].value.iloc[0], 3.4)
        months = df[df.period != "M13"].sort_values(["year", "period"])
        self.assertEqual(months.period.tolist(), ["M12", "M02", "M03"])
        self.assertEqual(months.value.tolist(), [3.1, 3.9, 3.7])

    def test_parse_empty_series(self):
        df = bls.parse_series([{"seriesID": "LAUMT481018000000003", "data": []}])
        self.assertEqual(len(df), 0)

    # bls reports a suppressed value as a dash. it lands as a missing float
    def test_dash_value_is_missing(self):
        df = bls.parse_series([{"seriesID": "LAUMT481018000000003", "data": [
            {"year": "2024", "period": "M06", "value": "-"},
        ]}])
        self.assertEqual(len(df), 1)
        self.assertTrue(pd.isna(df.value.iloc[0]))

    def test_only_annual_rows_yield_no_newest_month(self):
        df = bls.parse_series([{"seriesID": "LAUMT481018000000003", "data": [
            {"year": "2023", "period": "M13", "value": "3.4"},
            {"year": "2024", "period": "M13", "value": "3.5"},
        ]}])
        self.assertEqual(df.period.tolist(), ["M13", "M13"])

    # every month stays, and sorting by year then period finds the newest
    def test_months_keep_their_order_when_they_stop_mid_year(self):
        df = bls.parse_series([{"seriesID": "LAUMT481018000000003", "data": [
            {"year": "2024", "period": "M13", "value": "3.4"},
            {"year": "2024", "period": "M06", "value": "3.2"},
            {"year": "2024", "period": "M05", "value": "3.0"},
            {"year": "2023", "period": "M12", "value": "2.9"},
        ]}])
        months = df[df.period != "M13"].sort_values(["year", "period"])
        self.assertEqual(len(months), 3)
        self.assertEqual((months.year.iloc[-1], months.period.iloc[-1]), (2024, "M06"))

    def test_multiple_series_keep_their_own_cbsa_codes(self):
        df = bls.parse_series([
            {"seriesID": "LAUMT481018000000003", "data": [{"year": "2024", "period": "M13", "value": "3.4"}]},
            {"seriesID": "LAUMT171698000000003", "data": [{"year": "2024", "period": "M13", "value": "5.1"}]},
        ])
        self.assertEqual(dict(zip(df.cbsa_code, df.value)), {"10180": 3.4, "16980": 5.1})

    def test_empty_payload_has_the_documented_columns(self):
        df = bls.parse_series([])
        self.assertEqual(list(df.columns), ["series_id", "cbsa_code", "year", "period", "value"])
        self.assertEqual(len(df), 0)


class TestFred(unittest.TestCase):
    # fred marks missing weeks with a dot
    def test_dot_becomes_nan(self):
        df = fred.parse_observations([
            {"date": "2014-01-02", "value": "4.53"},
            {"date": "2014-01-09", "value": "."},
        ])
        self.assertEqual(df.value.iloc[0], 4.53)
        self.assertTrue(df.value.isna().iloc[1])

    def test_all_dots_gives_all_nan(self):
        df = fred.parse_observations([
            {"date": "2014-01-02", "value": "."},
            {"date": "2014-01-09", "value": "."},
        ])
        self.assertTrue(df.value.isna().all())
        self.assertEqual(len(df), 2)

    def test_values_are_numeric_dtype(self):
        df = fred.parse_observations([{"date": "2014-01-02", "value": "4.53"}])
        self.assertEqual(df.value.dtype.kind, "f")

    # an empty observation list currently raises KeyError inside the column
    # selection. documented here rather than fixed, see the report
    # an empty response still yields the two column frame, never a KeyError
    def test_empty_observations(self):
        df = fred.parse_observations([])
        self.assertEqual(list(df.columns), ["date", "value"])
        self.assertEqual(len(df), 0)


class TestZillowNewestMonth(unittest.TestCase):
    # zillow has no pure parser. this mirrors the header logic in collect()
    @staticmethod
    def newest_month(raw):
        header = raw.split(b"\n", 1)[0].decode()
        return header.rsplit(",", 1)[-1].strip(), raw.count(b"\n") - 1

    def test_newline_header(self):
        month, rows = self.newest_month(b"RegionID,RegionName,2026-06-30,2026-07-31\n10,x,1,2\n")
        self.assertEqual((month, rows), ("2026-07-31", 1))

    def test_carriage_return_header(self):
        month, rows = self.newest_month(b"RegionID,RegionName,2026-07-31\r\n10,x,1\r\n")
        self.assertEqual((month, rows), ("2026-07-31", 1))


if __name__ == "__main__":
    unittest.main()


class TestGazetteerDivisions(unittest.TestCase):
    COUNTY_TEXT = (
        "USPS\tGEOID\tANSICODE\tNAME\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG    \n"
        "IL\t17031\t1\tCook County\t1\t1\t945.0\t1.0\t41.84\t-87.82    \n"
        "IL\t17043\t1\tDuPage County\t1\t1\t327.0\t1.0\t41.85\t-88.09    \n"
        "IL\t17037\t1\tDeKalb County\t1\t1\t631.0\t1.0\t41.89\t-88.77    \n"
    )

    def delineation(self):
        import pandas as pd
        return pd.DataFrame({
            "cbsa_code": ["16984", "16984", "20994", "20994"],
            "name": ["Chicago-Naperville-Schaumburg, IL Metro Division"] * 2 + ["Elgin, IL Metro Division"] * 2,
            "parent_cbsa": ["16980"] * 4,
            "county_fips": ["17031", "17043", "17037", "17999"],  # 17999 has no gazetteer row
        })

    def test_parse_counties_types_and_columns(self):
        df = gazetteer.parse_counties(self.COUNTY_TEXT)
        self.assertEqual(list(df.columns), ["county_fips", "land_sqmi", "lat", "lon"])
        self.assertEqual(df.county_fips.tolist(), ["17031", "17043", "17037"])
        self.assertAlmostEqual(df.lon.iloc[0], -87.82)

    # land weighted, so cook county pulls the point toward itself
    def test_division_centroid_is_land_weighted(self):
        counties = gazetteer.parse_counties(self.COUNTY_TEXT)
        out = gazetteer.division_centroids(self.delineation(), counties)
        chi = out[out.cbsa_code == "16984"].iloc[0]
        expected_lat = (41.84 * 945 + 41.85 * 327) / (945 + 327)
        self.assertAlmostEqual(chi.lat, expected_lat, places=5)
        self.assertEqual(int(chi.cbsa_type), gazetteer.DIVISION)
        self.assertEqual(chi.parent_cbsa, "16980")
        self.assertAlmostEqual(chi.land_sqmi, 1272.0)

    # a county missing from the gazetteer is skipped, not zeroed
    def test_missing_county_is_skipped(self):
        counties = gazetteer.parse_counties(self.COUNTY_TEXT)
        out = gazetteer.division_centroids(self.delineation(), counties)
        elgin = out[out.cbsa_code == "20994"].iloc[0]
        self.assertAlmostEqual(elgin.lat, 41.89)
        self.assertEqual(list(out.columns), gazetteer.COLUMNS)

    def test_division_with_no_counties_left_is_dropped(self):
        import pandas as pd
        counties = gazetteer.parse_counties(self.COUNTY_TEXT)
        lone = pd.DataFrame({"cbsa_code": ["99999"], "name": ["Nowhere Metro Division"],
                             "parent_cbsa": ["11111"], "county_fips": ["00000"]})
        out = gazetteer.division_centroids(lone, counties)
        self.assertEqual(len(out), 0)


class TestGazetteerMembership(unittest.TestCase):
    ROWS = [
        # a plain metro, one county
        {"CBSA Code": "10180", "Metropolitan Division Code": None, "Metropolitan Division Title": None,
         "FIPS State Code": "48", "FIPS County Code": "441"},
        # a split metro: both counties belong to the metro and to a division
        {"CBSA Code": "16980", "Metropolitan Division Code": "16984",
         "Metropolitan Division Title": "Chicago-Naperville-Schaumburg, IL",
         "FIPS State Code": "17", "FIPS County Code": "031"},
        {"CBSA Code": "16980", "Metropolitan Division Code": "16984",
         "Metropolitan Division Title": "Chicago-Naperville-Schaumburg, IL",
         "FIPS State Code": "17", "FIPS County Code": "043"},
        # single digit state and two digit county, the zero padding case
        {"CBSA Code": "35300", "Metropolitan Division Code": None, "Metropolitan Division Title": None,
         "FIPS State Code": "9", "FIPS County Code": "170"},
    ]

    def workbook(self, rows):
        import io
        buffer = io.BytesIO()
        with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
            pd.DataFrame(rows).to_excel(writer, index=False, startrow=2)
        return buffer.getvalue()

    def membership(self, rows=None):
        return gazetteer.parse_membership(self.workbook(self.ROWS if rows is None else rows))

    def test_every_county_is_listed_under_its_cbsa(self):
        df = self.membership()
        self.assertEqual(df[df.cbsa_code == "16980"].county_fips.tolist(), ["17031", "17043"])
        self.assertEqual(df[df.cbsa_code == "10180"].county_fips.tolist(), ["48441"])

    # hud has no entity for a division, so the division needs its own counties
    def test_a_division_county_is_listed_twice(self):
        df = self.membership()
        self.assertEqual(df[df.cbsa_code == "16984"].county_fips.tolist(), ["17031", "17043"])
        self.assertEqual(len(df), 6)

    def test_fips_are_padded_to_five_digits_as_strings(self):
        df = self.membership()
        self.assertEqual(df[df.cbsa_code == "35300"].county_fips.tolist(), ["09170"])
        self.assertTrue(df.county_fips.str.len().eq(5).all())

    def test_columns_and_order(self):
        df = self.membership()
        self.assertEqual(list(df.columns), ["cbsa_code", "county_fips"])
        self.assertEqual(df.cbsa_code.tolist(), sorted(df.cbsa_code.tolist()))

    def test_a_repeated_pair_is_kept_once(self):
        df = self.membership(self.ROWS + [self.ROWS[0]])
        self.assertEqual(df[df.cbsa_code == "10180"].county_fips.tolist(), ["48441"])


class TestBlsDivisions(unittest.TestCase):
    # verified live: the chicago division answers under area type DV
    def test_division_series_uses_dv(self):
        self.assertEqual(bls.series_id("16984", "IL", division=True), "LAUDV171698400000003")
        self.assertEqual(bls.series_id("16984", "IL"), "LAUMT171698400000003")

    def test_division_series_parses_to_its_own_code(self):
        df = bls.parse_series([{"seriesID": "LAUDV171698400000003", "data": [
            {"year": "2024", "period": "M13", "value": "5.1"}]}])
        self.assertEqual(df.cbsa_code.tolist(), ["16984"])

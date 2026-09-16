import json
import sys
import unittest
from pathlib import Path
from unittest import mock

import pandas as pd
import requests

# scripts/ is not a package, so put it on the path before importing
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import download_census as dc


class TestGeographyTags(unittest.TestCase):
    def test_msa_rows_join_on_their_own_code(self):
        df = pd.DataFrame({"NAME": ["Abilene, TX Metro Area"], dc.MSA_COL: ["10180"]})
        out = dc.tag_geography(df, "msa")
        self.assertEqual(out.geo_code.tolist(), ["10180"])
        self.assertEqual(out.geo_level.tolist(), ["msa"])
        self.assertEqual(out.parent_cbsa.tolist(), [""])

    def test_division_rows_join_on_the_division_code(self):
        df = pd.DataFrame({"NAME": ["Elgin, IL Metro Division"], dc.MSA_COL: ["16980"], dc.DIV_COL: ["20994"]})
        out = dc.tag_geography(df, "division")
        self.assertEqual(out.geo_code.tolist(), ["20994"])
        self.assertEqual(out.parent_cbsa.tolist(), ["16980"])

    # chicago's 2014 vintage code was 16974. fhfa uses 16984 for every year
    def test_crosswalk_maps_renamed_divisions(self):
        df = pd.DataFrame({dc.MSA_COL: ["16980", "16980"], dc.DIV_COL: ["16974", "20994"]})
        out = dc.tag_geography(df, "division")
        self.assertEqual(out.geo_code.tolist(), ["16984", "20994"])
        self.assertEqual(out[dc.DIV_COL].tolist(), ["16974", "20994"])  # the api column is untouched

    def test_input_frame_is_not_mutated(self):
        df = pd.DataFrame({dc.MSA_COL: ["16980"], dc.DIV_COL: ["16974"]})
        dc.tag_geography(df, "division")
        self.assertNotIn("geo_code", df.columns)

    # a parent with no divisions in an older vintage comes back as a header only
    def test_empty_frame(self):
        df = pd.DataFrame(columns=["NAME", dc.MSA_COL, dc.DIV_COL])
        out = dc.tag_geography(df, "division")
        self.assertEqual(len(out), 0)
        self.assertIn("geo_code", out.columns)

    def test_parents_and_crosswalk_are_well_formed(self):
        self.assertEqual(len(dc.DIVISION_PARENTS), 13)
        self.assertEqual(len(set(dc.DIVISION_PARENTS)), 13)
        codes = dc.DIVISION_PARENTS + list(dc.DIVISION_CROSSWALK) + list(dc.DIVISION_CROSSWALK.values())
        for code in codes:
            self.assertRegex(code, r"^\d{5}$")
        # an old code never maps to another old code
        self.assertFalse(set(dc.DIVISION_CROSSWALK) & set(dc.DIVISION_CROSSWALK.values()))


# a 503 and a 204 both arrive with an empty body. only one of them means
# "this parent has no divisions in this vintage"
def fake_response(status_code, body=b"", content_type="application/json"):
    response = requests.Response()
    response.status_code = status_code
    response._content = body
    response.url = "https://api.census.gov/data/2024/acs/acs5"
    response.reason = {204: "No Content", 503: "Service Unavailable"}.get(status_code, "OK")
    response.headers["content-type"] = content_type
    return response


def payload(rows):
    body = [dc.VARIABLES + [dc.MSA_COL, dc.DIV_COL]] + rows
    return fake_response(200, json.dumps(body).encode())


class TestTransportErrorsAreNotEmptyResults(unittest.TestCase):
    # a transient 5xx carries an empty body, which must not read as "no divisions"
    def test_server_error_with_empty_body_raises(self):
        with mock.patch.object(dc.requests, "get", return_value=fake_response(503)):
            with self.assertRaises(requests.HTTPError):
                dc.query_acs(2024, "KEY", f"{dc.DIV_COL}:*", within=f"{dc.MSA_COL}:16980")

    # the legitimate case stays legitimate: 204 is an answer, not a failure
    def test_no_content_is_an_empty_frame(self):
        with mock.patch.object(dc.requests, "get", return_value=fake_response(204)):
            out = dc.query_acs(2024, "KEY", f"{dc.DIV_COL}:*", within=f"{dc.MSA_COL}:16980")
        self.assertEqual(len(out), 0)
        self.assertEqual(list(out.columns), dc.VARIABLES + [dc.MSA_COL, dc.DIV_COL])

    # one failed division call must fail the vintage, not silently drop its metros
    def test_failed_division_call_fails_the_vintage(self):
        row = ["Chicago-Naperville-Elgin, IL-IN Metro Area", "85000", "9500000",
               "38.1", "6500000", "1200000", "800000", "3400000", "2100000", "350000"]

        def responses(url, params=None, timeout=None):
            within = (params or {}).get("in", "")
            if within.endswith("16980"):
                return fake_response(503)
            if "in" in (params or {}):
                return payload([row + [within.split(":")[-1], "20994"]])
            return payload([row + ["16980", ""]])

        with mock.patch.object(dc.requests, "get", side_effect=responses):
            with self.assertRaises(requests.HTTPError):
                dc.fetch_acs_data(2024, "KEY")

# file header additions required by the block above:
#   import json
#   from unittest import mock
#   import requests

if __name__ == "__main__":
    unittest.main()

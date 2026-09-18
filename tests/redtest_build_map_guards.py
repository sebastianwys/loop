# not discovered by run_tests.py, run it deliberately from the project root:
#   ml/.venv/bin/python -m unittest tests.redtest_build_map_guards -v

import json
import unittest
from pathlib import Path

from bot import build_map_data as bm
from bot import indicators
from tests.test_build_map_data import BuildCase, fhfa_fixture, national_rows


# the fixtures next door, laid out the way data/raw is: one folder per
# collector, each carrying the manifest that names its version beside the file
# the build reads out of it
class GuardCase(BuildCase):
    def setUp(self):
        super().setUp()
        self.paths["fhfa"] = self.collector("fhfa", "hpi_master.csv", "2026-Q2")
        fhfa_fixture().to_csv(self.paths["fhfa"], index=False)
        self.paths["national"] = self.collector("national", "indicators.csv", "through 2026-08-01")
        self.paths["national"].write_text(national_rows())
        self.extras = self.collector("extras", bm.ENRICHMENT_FILE, "through 2026-08")
        self.extras.write_text("cbsa_code,metric,period,value\n10180,permits,2024,850\n")
        self.out = Path(self.tmp.name) / "metros.json"

    def collector(self, name, filename, version):
        folder = Path(self.tmp.name) / name
        folder.mkdir(exist_ok=True)
        (folder / bm.MANIFEST_FILE).write_text(json.dumps([{
            "filename": filename,
            "source": {"url": f"https://example.org/{name}/{filename}", "provider": name},
            "integrity": {"sha256": "abc123", "row_count": 1},
            "version": version,
            "downloaded_at": "2026-09-16T00:00:00Z",
        }]))
        return folder / filename

    def absent(self, name):
        return Path(self.tmp.name) / f"absent_{name}.csv"


# a version string says which vintage of a source this build read. thirteen of
# the seventeen are read off the manifest sitting on disk instead, so a build
# that never opened the file still advertises its version, and the loss guard,
# which compares those strings, is left comparing the manifests to themselves
class TestASourceVersionIsEvidenceTheBuildReadIt(GuardCase):
    def test_a_missing_price_history_stops_the_rebuild(self):
        full = self.build_to(self.out)
        self.assertIsNotNone(full["metros"][0]["latest"]["hpi"])
        before = self.out.read_bytes()
        paths = dict(self.paths)
        paths["fhfa"] = self.absent("fhfa")
        with self.assertRaises(RuntimeError) as raised:
            bm.build(out_path=self.out, paths=paths)
        self.assertIn("fhfa", str(raised.exception))
        self.assertEqual(self.out.read_bytes(), before)

    def test_a_missing_indicators_file_stops_the_rebuild(self):
        full = self.build_to(self.out)
        self.assertEqual(len(full["national"]["indicators"]), len(indicators.INDICATORS))
        before = self.out.read_bytes()
        paths = dict(self.paths)
        paths["national"] = self.absent("national")
        with self.assertRaises(RuntimeError) as raised:
            bm.build(out_path=self.out, paths=paths)
        self.assertIn("national", str(raised.exception))
        self.assertEqual(self.out.read_bytes(), before)

    # an enrichment folder is the same story reached another way: the download
    # is gitignored, the manifest beside it is not, so a checkout that has not
    # run the collector keeps advertising the version and blanks the metrics
    def test_a_missing_enrichment_file_stops_the_rebuild(self):
        full = self.build_to(self.out)
        self.assertEqual(self.metro(full, "10180")["years"]["2024"]["permits"], 850.0)
        before = self.out.read_bytes()
        self.extras.unlink()
        with self.assertRaises(RuntimeError) as raised:
            bm.build(out_path=self.out, paths=dict(self.paths))
        self.assertIn("extras", str(raised.exception))
        self.assertEqual(self.out.read_bytes(), before)

    # the cause, on a first build so the loss guard is not in the way. the
    # vintage line in the discovered suite asserts today's reading for this
    # case, so a fix here has to settle which of the two speaks for a source
    def test_a_version_is_not_advertised_for_a_file_the_build_never_opened(self):
        paths = dict(self.paths)
        paths["fhfa"] = self.absent("fhfa")
        fresh = Path(self.tmp.name) / "fresh.json"
        payload = json.loads(bm.build(out_path=fresh, paths=paths).read_text())
        self.assertNotIn("series", payload["metros"][0])
        self.assertIsNone(payload["sources"].get("fhfa"))


# the refusal compares the two sources blocks and nothing else, so a build that
# read every manifest and produced no metros at all walks straight through it
class TestARebuildCannotBlankTheMap(GuardCase):
    def test_a_rebuild_that_reads_no_centroid_refuses_to_write(self):
        full = self.build_to(self.out)
        self.assertEqual(len(full["metros"]), 3)
        before = self.out.read_bytes()
        headers = Path(self.tmp.name) / "no_centroids.csv"
        headers.write_text(Path(self.paths["centroids"]).read_text().splitlines()[0] + "\n")
        paths = dict(self.paths)
        paths["centroids"] = headers
        refused = None
        try:
            bm.build(out_path=self.out, paths=paths)
        except RuntimeError as error:
            refused = str(error)
        # the file on disk is the map the site serves, so it keeps its metros
        self.assertEqual(len(json.loads(self.out.read_text())["metros"]), 3)
        self.assertEqual(self.out.read_bytes(), before)
        self.assertIsNotNone(refused, "the rebuild wrote an empty map instead of refusing")

    # and a rebuild that can see everything still goes through
    def test_a_rebuild_that_keeps_its_metros_is_fine(self):
        self.build_to(self.out)
        again = self.build_to(self.out)
        self.assertEqual(len(again["metros"]), 3)


if __name__ == "__main__":
    unittest.main()

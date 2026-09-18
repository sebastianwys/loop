import hashlib
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests

from bot import common

EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


class TestManifest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.path = self.folder / "sample.csv"
        self.path.write_bytes(b"a,b\n" * 384)  # 1536 bytes, 1.5 kb exactly

    def tearDown(self):
        self.tmp.cleanup()

    def test_entry_shape(self):
        entry = common.manifest_entry(self.path, "https://files.example.com/x.csv", "prov", "ds", "v1", 383)
        self.assertEqual(list(entry), ["filename", "file_format", "source", "integrity", "version", "downloaded_at"])
        self.assertEqual(entry["filename"], "sample.csv")
        self.assertEqual(entry["file_format"], "CSV")
        self.assertEqual(list(entry["source"]), ["endpoint", "provider", "access_method", "dataset"])
        self.assertEqual(list(entry["integrity"]), ["sha256", "size_kb", "row_count"])
        self.assertEqual(entry["integrity"]["row_count"], 383)

    def test_sha_matches_hashlib(self):
        entry = common.manifest_entry(self.path, "https://x", "p", "d", "v", 1)
        self.assertEqual(entry["integrity"]["sha256"], hashlib.sha256(self.path.read_bytes()).hexdigest())

    def test_size_kb_rounds_to_one_decimal(self):
        self.assertEqual(common.manifest_entry(self.path, "https://x", "p", "d", "v", 1)["integrity"]["size_kb"], 1.5)
        odd = self.folder / "odd.txt"
        odd.write_bytes(b"x" * 1100)  # 1.074 kb
        self.assertEqual(common.manifest_entry(odd, "https://x", "p", "d", "v", 1)["integrity"]["size_kb"], 1.1)

    def test_access_method_from_endpoint(self):
        api = common.manifest_entry(self.path, "https://api.bls.gov/publicAPI/v2/", "p", "d", "v", 1)
        direct = common.manifest_entry(self.path, "https://www2.census.gov/geo/docs/x.zip", "p", "d", "v", 1)
        self.assertEqual(api["source"]["access_method"], "REST API")
        self.assertEqual(direct["source"]["access_method"], "Direct HTTP download")

    # notes only appear when given, so older manifests keep their exact shape
    def test_notes_key_only_when_given(self):
        self.assertNotIn("notes", common.manifest_entry(self.path, "https://x", "p", "d", "v", 1))
        self.assertNotIn("notes", common.manifest_entry(self.path, "https://x", "p", "d", "v", 1, notes={}))
        entry = common.manifest_entry(self.path, "https://x", "p", "d", "v", 1, notes={"keyed": False})
        self.assertEqual(entry["notes"], {"keyed": False})

    def test_write_manifest(self):
        entries = [{"filename": "a"}, {"filename": "b"}]
        path = common.write_manifest(self.folder, entries)
        self.assertEqual(path, self.folder / "download_manifest.json")
        text = path.read_text()
        self.assertTrue(text.endswith("\n"))
        self.assertEqual(json.loads(text), entries)


class TestHelpers(unittest.TestCase):
    def test_sha256_of_empty_file(self):
        with tempfile.NamedTemporaryFile() as f:
            self.assertEqual(common.sha256_file(Path(f.name)), EMPTY_SHA)

    def test_utc_now_format(self):
        self.assertRegex(common.utc_now(), r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

    def test_env_key_strips(self):
        with patch.dict(os.environ, {"BOT_TEST_KEY": "  abc123  "}):
            self.assertEqual(common.env_key("BOT_TEST_KEY"), "abc123")

    def test_env_key_unset_is_empty_string(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(common.env_key("BOT_TEST_KEY"), "")


def response(status):
    return Mock(status_code=status)


@patch("bot.common.time.sleep")
@patch("bot.common.requests.post")
@patch("bot.common.requests.get")
class TestFetch(unittest.TestCase):
    def test_first_attempt_ok_no_sleep(self, get, post, sleep):
        get.return_value = response(200)
        self.assertEqual(common.fetch("https://x").status_code, 200)
        self.assertEqual(get.call_count, 1)
        sleep.assert_not_called()
        post.assert_not_called()

    # one 5xx costs exactly one backoff, then the good response comes back
    def test_503_then_200(self, get, post, sleep):
        get.side_effect = [response(503), response(200)]
        self.assertEqual(common.fetch("https://x").status_code, 200)
        self.assertEqual(get.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_three_503s_raise(self, get, post, sleep):
        get.side_effect = [response(503), response(503), response(503)]
        with self.assertRaises(RuntimeError) as ctx:
            common.fetch("https://x")
        self.assertIn("503", str(ctx.exception))
        self.assertEqual(get.call_count, 3)
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [1, 2, 4])

    def test_connection_error_then_200(self, get, post, sleep):
        get.side_effect = [requests.ConnectionError("boom"), response(200)]
        self.assertEqual(common.fetch("https://x").status_code, 200)
        self.assertEqual(get.call_count, 2)

    # 4xx is the caller's problem, not a transient failure
    def test_404_returned_not_retried(self, get, post, sleep):
        get.return_value = response(404)
        self.assertEqual(common.fetch("https://x").status_code, 404)
        self.assertEqual(get.call_count, 1)
        sleep.assert_not_called()

    def test_json_body_routes_to_post(self, get, post, sleep):
        post.return_value = response(200)
        common.fetch("https://x", json_body={"seriesid": ["a"]})
        get.assert_not_called()
        self.assertEqual(post.call_args.kwargs["json"], {"seriesid": ["a"]})
        self.assertEqual(post.call_args.kwargs["headers"]["User-Agent"], common.USER_AGENT)

    def test_user_agent_on_every_get(self, get, post, sleep):
        get.side_effect = [response(503), response(200)]
        common.fetch("https://x", params={"q": 1})
        for call in get.call_args_list:
            self.assertEqual(call.kwargs["headers"]["User-Agent"], common.USER_AGENT)
            self.assertEqual(call.kwargs["params"], {"q": 1})

    def test_retries_argument_is_respected(self, get, post, sleep):
        get.return_value = response(500)
        with self.assertRaises(RuntimeError):
            common.fetch("https://x", retries=1)
        self.assertEqual(get.call_count, 1)


# a scheduled refresh that finds nothing new must leave the repo alone. with a
# fresh timestamp on every write, a daily run commits the whole file to move a
# clock, and the map is rebuilt and republished for no reason
class TestWritesAreIdempotent(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)

    def entry(self, when, rows=10):
        return {"filename": "metrics.csv", "integrity": {"row_count": rows},
                "downloaded_at": when}

    def test_the_same_manifest_twice_is_the_same_bytes(self):
        first = common.write_manifest(self.folder, [self.entry("2026-09-15T00:00:00Z")])
        before = first.read_bytes()
        common.write_manifest(self.folder, [self.entry("2026-09-16T06:00:00Z")])
        self.assertEqual(first.read_bytes(), before)

    def test_a_real_change_carries_the_new_timestamp(self):
        path = common.write_manifest(self.folder, [self.entry("2026-09-15T00:00:00Z")])
        common.write_manifest(self.folder, [self.entry("2026-09-16T06:00:00Z", rows=11)])
        written = json.loads(path.read_text())
        self.assertEqual(written[0]["integrity"]["row_count"], 11)
        self.assertEqual(written[0]["downloaded_at"], "2026-09-16T06:00:00Z")

    def test_a_first_write_keeps_its_own_timestamp(self):
        path = common.write_manifest(self.folder, [self.entry("2026-09-15T00:00:00Z")])
        self.assertEqual(json.loads(path.read_text())[0]["downloaded_at"], "2026-09-15T00:00:00Z")


# every raw file under data/raw is the only copy the pipeline has of a vintage
# its publisher does not keep, so a write that dies partway has to cost the new
# file rather than the old one
class TestAnArchiveIsRenamedOverNeverTruncated(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.path = self.folder / "metrics.csv"
        self.path.write_text("cbsa_code,value\n10180,1\n")

    def test_a_write_that_finishes_lands(self):
        common.replace_atomically(self.path, lambda staged: staged.write_text("new\n"))
        self.assertEqual(self.path.read_text(), "new\n")

    def test_a_write_that_raises_leaves_the_previous_file_whole(self):
        def dies(staged):
            staged.write_text("half")
            raise OSError("no space left on device")
        with self.assertRaises(OSError):
            common.replace_atomically(self.path, dies)
        self.assertEqual(self.path.read_text(), "cbsa_code,value\n10180,1\n")

    # a half written body left in the folder would be worse than the truncation
    def test_a_write_that_raises_leaves_nothing_half_written_behind(self):
        with self.assertRaises(OSError):
            common.replace_atomically(self.path, lambda staged: (_ for _ in ()).throw(OSError("boom")))
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), ["metrics.csv"])

    def test_the_body_never_reaches_the_destination_path(self):
        seen = []
        common.replace_atomically(self.path, lambda staged: (seen.append(staged), staged.write_text("x\n")))
        self.assertNotEqual(seen[0], self.path)
        self.assertEqual(seen[0].name, "metrics.csv.part")


# one file at a time is not enough for a collector that writes several. a run
# that dies between two of them would leave some of this run's files beside
# some of the last one's, under a manifest describing neither set
class TestAFolderIsReplacedWholeOrNotAtAll(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        (self.folder / "one.csv").write_text("old one\n")
        (self.folder / "two.csv").write_text("old two\n")

    def names(self):
        return sorted(p.name for p in self.folder.iterdir())

    def test_every_file_lands_when_the_body_finishes(self):
        with common.staged_folder(self.folder) as landing:
            landing.text("one.csv", "new one\n")
            landing.text("two.csv", "new two\n")
        self.assertEqual((self.folder / "one.csv").read_text(), "new one\n")
        self.assertEqual((self.folder / "two.csv").read_text(), "new two\n")

    def test_a_body_that_raises_lands_none_of_them(self):
        with self.assertRaises(RuntimeError):
            with common.staged_folder(self.folder) as landing:
                landing.text("one.csv", "new one\n")
                raise RuntimeError("the second fetch failed")
        self.assertEqual((self.folder / "one.csv").read_text(), "old one\n")
        self.assertEqual((self.folder / "two.csv").read_text(), "old two\n")

    # the staging directory goes with it, so the next run reads a folder that
    # holds one run's files and nothing else
    def test_the_staging_directory_is_gone_either_way(self):
        with common.staged_folder(self.folder) as landing:
            landing.text("one.csv", "new one\n")
        self.assertEqual(self.names(), ["one.csv", "two.csv"])
        with self.assertRaises(RuntimeError):
            with common.staged_folder(self.folder):
                raise RuntimeError("boom")
        self.assertEqual(self.names(), ["one.csv", "two.csv"])

    # manifest_entry hashes and names the file the run produced, which is why
    # the staged file keeps the name it will land under
    def test_a_staged_file_carries_the_name_it_will_land_under(self):
        with common.staged_folder(self.folder) as landing:
            staged = landing.path("one.csv")
            self.assertEqual(staged.name, "one.csv")
            self.assertNotEqual(staged.parent, self.folder)
            staged.write_text("new one\n")

    def test_the_manifest_lands_with_the_files_it_describes(self):
        with common.staged_folder(self.folder) as landing:
            landing.text("one.csv", "new one\n")
            landing.manifest([{"filename": "one.csv", "integrity": {"row_count": 1},
                               "downloaded_at": "2026-09-17T00:00:00Z"}])
        written = json.loads((self.folder / common.MANIFEST_FILE).read_text())
        self.assertEqual(written[0]["filename"], "one.csv")

    def test_a_manifest_that_did_not_move_is_left_alone(self):
        entries = [{"filename": "one.csv", "integrity": {"row_count": 1},
                    "downloaded_at": "2026-09-17T00:00:00Z"}]
        with common.staged_folder(self.folder) as landing:
            landing.manifest(entries)
        before = (self.folder / common.MANIFEST_FILE).read_bytes()
        with common.staged_folder(self.folder) as landing:
            landing.manifest([dict(entries[0], downloaded_at="2026-09-18T06:00:00Z")])
        self.assertEqual((self.folder / common.MANIFEST_FILE).read_bytes(), before)


if __name__ == "__main__":
    unittest.main()

# a red test. run_tests.py discovers test*.py, so this one runs on its own:
#   ml/.venv/bin/python -m unittest tests.redtest_preflight_origin_main -v

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

# web/scripts/preflight-deploy.mjs runs before `npm run deploy` and exists to
# stop a hand deploy from publishing older data than the scheduled runs have
# put live. those runs commit to main and nowhere else, so a checkout that
# lacks a commit on origin/main rolls the site back whatever branch it is on.
# a feature branch pushed to its own upstream is level with that upstream and
# can still be a day of data behind main.
#
# each case builds a throwaway repo whose origin is a bare repo on disk, so the
# fetch the preflight makes never leaves the machine, and runs the real script
# from the checkout the way npm's predeploy hook does
REPO_ROOT = Path(__file__).resolve().parent.parent
PREFLIGHT = REPO_ROOT / "web" / "scripts" / "preflight-deploy.mjs"

LIVE_DATA = "web/public/data/metros.json"


class DeployCase(unittest.TestCase):
    def setUp(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node is not installed")
        self.node = node
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        (self.root / "gitconfig").write_text(
            "[user]\n\tname = preflight test\n\temail = preflight@example.invalid\n"
            "[init]\n\tdefaultBranch = main\n"
            "[commit]\n\tgpgsign = false\n"
        )
        # nothing from the calling shell decides the answer: no forced deploy,
        # no git state pointing elsewhere, and no climbing out of the tree
        # into whatever repository it happens to sit in. git stops below a
        # ceiling, never at it, so the ceiling is the tree's parent
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith("GIT_") and k != "LOOP_DEPLOY_FORCE"}
        self.env.update({
            "GIT_CONFIG_GLOBAL": str(self.root / "gitconfig"),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CEILING_DIRECTORIES": str(self.root.parent),
            "GIT_TERMINAL_PROMPT": "0",
        })

        self.origin = self.root / "origin.git"
        self.git("init", "--bare", "-q", str(self.origin), cwd=self.root)
        self.work = self.root / "work"
        self.git("clone", "-q", str(self.origin), str(self.work), cwd=self.root)
        self.commit(self.work, LIVE_DATA, '{"national": "through 2026-09-16"}\n', "data as of the 16th")
        self.git("branch", "-M", "main", cwd=self.work)
        self.git("push", "-q", "-u", "origin", "main", cwd=self.work)

    def git(self, *args, cwd):
        return subprocess.run(["git", *args], cwd=str(cwd), env=self.env, capture_output=True,
                              text=True, check=True, timeout=60).stdout.strip()

    def commit(self, checkout, path, text, message):
        target = checkout / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        self.git("add", path, cwd=checkout)
        self.git("commit", "-q", "-m", message, cwd=checkout)

    # a feature branch with work of its own, pushed with its own upstream
    def cut_feature(self, name="feature"):
        self.git("checkout", "-q", "-b", name, cwd=self.work)
        self.commit(self.work, "web/src/layout.ts", "export const GAP = 8;\n", "web: a layout change")
        self.git("push", "-q", "-u", "origin", name, cwd=self.work)

    # the scheduled run lands newer data on main from a checkout of its own
    def scheduled_refresh(self):
        bot = self.root / "bot"
        self.git("clone", "-q", str(self.origin), str(bot), cwd=self.root)
        self.commit(bot, LIVE_DATA, '{"national": "through 2026-09-17"}\n', "bot: national strip refresh")
        self.git("push", "-q", "origin", "main", cwd=bot)

    def preflight(self):
        result = subprocess.run([self.node, str(PREFLIGHT)], cwd=str(self.work), env=self.env,
                                capture_output=True, text=True, timeout=120)
        output = (result.stdout + result.stderr).strip()
        # the script prints a line on every path through main, so silence
        # would mean it never ran rather than that it let the tree through
        self.assertIn("[preflight]", output)
        return result, output


class TestADeployBehindOriginMainIsStopped(DeployCase):
    # the case the guard was written for, and proof the harness reproduces it
    def test_main_behind_origin_main_is_stopped(self):
        self.scheduled_refresh()
        result, output = self.preflight()
        self.assertNotEqual(result.returncode, 0, output)

    # and the guard must not stop a branch that already holds everything live
    def test_a_feature_branch_that_holds_origin_main_goes(self):
        self.scheduled_refresh()
        self.git("pull", "-q", "--ff-only", "origin", "main", cwd=self.work)
        self.cut_feature()
        result, output = self.preflight()
        self.assertEqual(result.returncode, 0, output)

    # level with origin/feature, a day of data behind origin/main
    def test_a_feature_branch_behind_origin_main_is_stopped(self):
        self.cut_feature()
        self.scheduled_refresh()
        result, output = self.preflight()
        self.assertNotEqual(result.returncode, 0,
                            f"a deploy from here publishes {LIVE_DATA} through 2026-09-16 over a "
                            f"live 2026-09-17, and the preflight said: {output}")

    # never pushed, so no upstream at all, and origin/main is still right there
    def test_a_local_branch_behind_origin_main_is_stopped(self):
        self.git("checkout", "-q", "-b", "local-only", cwd=self.work)
        self.scheduled_refresh()
        result, output = self.preflight()
        self.assertNotEqual(result.returncode, 0,
                            f"a deploy from here publishes {LIVE_DATA} through 2026-09-16 over a "
                            f"live 2026-09-17, and the preflight said: {output}")


# a clone can call its remote something other than origin. there is no
# origin/main to count against then, so the branch's own upstream is what
# holds it back
class TestARemoteNotNamedOrigin(DeployCase):
    def setUp(self):
        super().setUp()
        self.git("remote", "rename", "origin", "github", cwd=self.work)

    def test_main_behind_its_upstream_is_stopped(self):
        self.scheduled_refresh()
        result, output = self.preflight()
        self.assertNotEqual(result.returncode, 0,
                            f"a deploy from here publishes {LIVE_DATA} through 2026-09-16 over a "
                            f"live 2026-09-17, and the preflight said: {output}")

    # a checkout with no origin has not failed to reach one
    def test_main_level_with_its_upstream_goes_and_says_so(self):
        result, output = self.preflight()
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("level with github/main", output)

    # and a remote it really cannot reach is still reported
    def test_an_unreachable_remote_is_reported(self):
        self.git("remote", "set-url", "github", str(self.root / "missing.git"), cwd=self.work)
        result, output = self.preflight()
        self.assertEqual(result.returncode, 0, output)
        self.assertIn("could not reach the remote", output)


if __name__ == "__main__":
    unittest.main()

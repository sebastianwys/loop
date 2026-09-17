// refuses to publish a tree that is behind the remote.
//
// wrangler publishes the whole dist directory as one manifest rather than a
// diff, and its "already uploaded" line means the content was in the asset
// store, not that the file is unchanged. so a hand deploy republishes every
// file the local tree built, including data that a scheduled run has since
// refreshed. every build input except the gitignored zillow csvs is tracked,
// so being level with origin is as close as this gets to knowing the inputs
// are current.
//
// runs from web/ before `npm run deploy`. ci calls wrangler directly from a
// fresh checkout, so it never reaches this.
//
//   node scripts/preflight-deploy.mjs
//   LOOP_DEPLOY_FORCE=1 npm run deploy     deliberately publish an old tree
import { execFileSync } from "node:child_process";

// the counts git reports for a branch against its upstream, turned into one
// decision. stop is the only one that blocks: a tree behind the remote would
// publish numbers older than the ones already live. ahead on its own is the
// ordinary case of deploying work that is not pushed yet
export function verdict({ upstream, fetched, behind, ahead }) {
  if (!upstream) {
    return { level: "warn", message: "this branch has no upstream, so there is nothing to compare against" };
  }
  if (!fetched) {
    return { level: "warn", message: `could not reach the remote, so ${upstream} may be newer than it looks` };
  }
  if (behind > 0 && ahead > 0) {
    return {
      level: "stop",
      message: `this branch has diverged from ${upstream}, ${ahead} ahead and ${behind} behind. `
        + "rebase first, rebuild, and deploy that",
    };
  }
  if (behind > 0) {
    return {
      level: "stop",
      message: `this branch is ${behind} behind ${upstream}. a deploy from here would publish `
        + "older data than what is live. pull, rebuild the map data, and deploy that",
    };
  }
  if (ahead > 0) {
    return { level: "go", message: `level with ${upstream}, ${ahead} commit(s) not pushed yet` };
  }
  return { level: "go", message: `level with ${upstream}` };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function read() {
  let upstream = null;
  try {
    upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  } catch {
    return { upstream: null, fetched: false, behind: 0, ahead: 0 };
  }

  let fetched = true;
  try {
    // a shallow timeout keeps a dead network from hanging the deploy
    execFileSync("git", ["fetch", "--quiet", upstream.split("/")[0]], { stdio: "ignore", timeout: 20000 });
  } catch {
    fetched = false;
  }

  const counts = git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]).split(/\s+/);
  return { upstream, fetched, behind: Number(counts[0]) || 0, ahead: Number(counts[1]) || 0 };
}

function main() {
  const forced = process.env.LOOP_DEPLOY_FORCE === "1" || process.argv.includes("--force");
  let state;
  try {
    state = read();
  } catch {
    console.log("[preflight] not a git checkout, nothing to check");
    return;
  }

  const { level, message } = verdict(state);
  if (level === "stop" && !forced) {
    console.error(`[preflight] ${message}`);
    console.error("[preflight] to publish this tree anyway: LOOP_DEPLOY_FORCE=1 npm run deploy");
    process.exit(1);
  }
  const prefix = level === "stop" ? "[preflight] forced past:" : "[preflight]";
  console.log(`${prefix} ${message}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

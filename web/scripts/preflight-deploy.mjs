// refuses to publish a tree that is behind the remote.
//
// wrangler publishes the whole dist directory as one manifest rather than a
// diff, and its "already uploaded" line means the content was in the asset
// store, not that the file is unchanged. so a hand deploy republishes every
// file the local tree built, including data that a scheduled run has since
// refreshed. every build input except the gitignored zillow csvs is tracked,
// so holding every commit on origin/main is as close as this gets to knowing
// the inputs are current. the scheduled runs commit there and nowhere else,
// so that is the check on any branch: a feature branch level with its own
// upstream can still be a day of data behind main. the branch's own upstream
// is checked as well, whatever its remote is called, and a branch with none
// is still held to origin/main.
//
// runs from web/ before `npm run deploy`. ci calls wrangler directly from a
// fresh checkout, so it never reaches this.
//
//   node scripts/preflight-deploy.mjs
//   LOOP_DEPLOY_FORCE=1 npm run deploy     deliberately publish an old tree
import { execFileSync } from "node:child_process";

// where the scheduled runs commit refreshed data and publish from
export const LIVE = "origin/main";

// the counts git reports for HEAD against origin/main and against the
// branch's upstream, turned into one decision. stop is the only one that
// blocks: a tree missing a commit on origin/main would publish numbers older
// than the ones already live, whatever branch it is on. ahead on its own is
// the ordinary case of deploying work that is not pushed yet. live is null
// when the checkout has no origin/main to count against. both counts are
// taken against the last fetch, so a tree already behind either ref stops
// even when the remote cannot be reached, and an unreachable remote is only
// a warning when nothing is known to be behind
export function verdict({ upstream, fetched, behind, ahead, live = null }) {
  if (live && live.behind > 0) {
    const where = live.ahead > 0
      ? `this checkout has diverged from ${LIVE}, ${live.ahead} ahead and ${live.behind} behind`
      : `this checkout is ${live.behind} behind ${LIVE}`;
    return {
      level: "stop",
      message: `${where}. a deploy from here would publish older data than what is live. `
        + `bring ${LIVE} in, rebuild the map data, and deploy that`,
    };
  }
  if (!upstream) {
    if (!live) {
      return {
        level: "warn",
        message: `this branch has no upstream and there is no ${LIVE} here, so there is nothing to compare against`,
      };
    }
    if (!fetched) {
      return { level: "warn", message: `could not reach the remote, so ${LIVE} may be newer than it looks` };
    }
    return { level: "go", message: `this branch has no upstream, and it holds everything on ${LIVE}` };
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
  if (!fetched) {
    return { level: "warn", message: `could not reach the remote, so ${upstream} may be newer than it looks` };
  }
  if (ahead > 0) {
    return { level: "go", message: `level with ${upstream}, ${ahead} commit(s) not pushed yet` };
  }
  return { level: "go", message: `level with ${upstream}` };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// null instead of a throw, for refs a checkout may not have
function maybe(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

// how far HEAD is behind and ahead of a ref
function counts(ref) {
  const [behind, ahead] = git(["rev-list", "--left-right", "--count", `${ref}...HEAD`]).split(/\s+/);
  return { behind: Number(behind) || 0, ahead: Number(ahead) || 0 };
}

function read() {
  // throws outside a git checkout, which main reports
  git(["rev-parse", "--git-dir"]);
  const upstream = maybe(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  // the remote the branch tracks, read from its config rather than cut off
  // the front of the ref, since a remote can be named anything
  const branch = upstream ? maybe(["symbolic-ref", "--quiet", "--short", "HEAD"]) : null;
  const tracked = branch ? maybe(["config", "--get", `branch.${branch}.remote`]) : null;

  // origin is fetched whether or not this branch tracks anything there, since
  // origin/main is what the scheduled runs move. only remotes this checkout
  // has are fetched: a checkout with no origin has no origin/main to fall
  // behind, which is not the same as a remote it could not reach. an upstream
  // that is a local branch has "." for its remote and needs no fetch
  const configured = git(["remote"]).split("\n");
  const remotes = new Set([LIVE.split("/")[0], tracked].filter((remote) => configured.includes(remote)));
  let fetched = true;
  for (const remote of remotes) {
    try {
      // a shallow timeout keeps a dead network from hanging the deploy
      execFileSync("git", ["fetch", "--quiet", remote], { stdio: "ignore", timeout: 20000 });
    } catch {
      fetched = false;
    }
  }

  // an offline run still counts against origin/main and the upstream as the
  // last fetch left them
  const live = maybe(["rev-parse", "--verify", "--quiet", `${LIVE}^{commit}`]) === null ? null : counts(LIVE);
  const own = upstream ? counts(upstream) : { behind: 0, ahead: 0 };
  return { upstream, fetched, ...own, live };
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

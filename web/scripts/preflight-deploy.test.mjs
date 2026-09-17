import { describe, expect, it } from "vitest";
import { verdict } from "./preflight-deploy.mjs";

const at = (behind, ahead) => verdict({ upstream: "origin/main", fetched: true, behind, ahead });

describe("the deploy preflight", () => {
  it("lets a tree level with the remote through", () => {
    expect(at(0, 0).level).toBe("go");
  });

  // the ordinary case: work committed locally, not pushed, deployed to look at
  it("lets an unpushed commit through", () => {
    const out = at(0, 3);
    expect(out.level).toBe("go");
    expect(out.message).toContain("3 commit(s) not pushed");
  });

  // the case that regressed the national strip: a scheduled run refreshed the
  // data and the local tree still built from yesterday's
  it("stops a tree that is behind, and says what it would do", () => {
    const out = at(1, 0);
    expect(out.level).toBe("stop");
    expect(out.message).toContain("1 behind origin/main");
    expect(out.message).toContain("older data than what is live");
  });

  it("stops a diverged tree and names both counts", () => {
    const out = at(2, 5);
    expect(out.level).toBe("stop");
    expect(out.message).toContain("5 ahead and 2 behind");
  });

  // neither of these should block a deploy: they are unknowns, not known bad
  it("warns rather than stops when there is nothing to compare against", () => {
    expect(verdict({ upstream: null, fetched: false, behind: 0, ahead: 0 }).level).toBe("warn");
  });

  it("warns rather than stops when the remote could not be reached", () => {
    const out = verdict({ upstream: "origin/main", fetched: false, behind: 0, ahead: 0 });
    expect(out.level).toBe("warn");
    expect(out.message).toContain("could not reach the remote");
  });
});

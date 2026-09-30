// red tests: counts and causes the model page states in prose.
// the vitest include only takes *.test.ts, so run this on purpose:
//   cd web && npx vitest run --config redtest.config.ts src/lib/modelprose.redtest.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelPage } from "../components/ModelPage";
import { inWords, type BacktestRow } from "./model";
import { INPUTS } from "./modelNumbers";
import { DEFAULT_ROUTE } from "./route";
import type { Shell } from "./views";
import type { MapData } from "../types";

const ROOT = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
const git = (...args: string[]) => execFileSync("git", args, { cwd: fileURLToPath(ROOT), encoding: "utf8" });

const ASSETS = new URL("web/scripts/model-assets.mjs", ROOT).href;
type Assets = { BACKTEST_FILES: string[]; testRows: (text: string) => BacktestRow[] };
const assets = () => import(ASSETS) as Promise<Assets>;

// the shipped build, the file the site loads, and the contract the panel builder published
const DATA = JSON.parse(read("web/public/data/metros.json")) as MapData;
const MANIFEST = JSON.parse(read("ml/results/panel_manifest.json")) as {
  features: { sequence: string[]; annual: string[] };
  context: string[];
};

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

// the page as a visitor reads it: the markup without its tags, whitespace collapsed
const plain = (html: string) =>
  html.replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const PAGE = plain(renderToStaticMarkup(createElement(ModelPage, {
  data: DATA,
  route: { ...DEFAULT_ROUTE, view: "model" },
  go: () => {},
  viewport: { width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false },
  shell,
})));

describe("the panel paragraph counts the columns the shipped contract has", () => {
  const features = MANIFEST.features.sequence.length + MANIFEST.features.annual.length;
  const context = MANIFEST.context.length;

  // the generated module and the manifest agree, so a fix can render the
  // counts from INPUTS the way the rest of the page already does
  it("reads the same contract the generated module carries", () => {
    expect(INPUTS).toEqual({ sequence: MANIFEST.features.sequence.length, annual: MANIFEST.features.annual.length, context });
  });

  it("says as many features feed the models as the manifest lists", () => {
    expect(/(\w+) features feed the models/i.exec(PAGE)?.[1]?.toLowerCase()).toBe(inWords(features));
  });

  it("says as many more columns ride along as the manifest's context lists", () => {
    expect(/(\w+) more columns ride along/i.exec(PAGE)?.[1]?.toLowerCase()).toBe(inWords(context));
  });
});

describe("'every model improved when the two FHFA columns joined'", () => {
  // the commit that put the expanded index into spec.FEATURES, found rather
  // than typed, and the test block each model scored on either side of it
  const joined = git("log", "--reverse", "--format=%H", "-S", "\"hpi_exp_yoy\",", "--", "ml/src/loop/spec.py")
    .trim().split("\n")[0];

  async function unmoved(): Promise<string[]> {
    const { BACKTEST_FILES, testRows } = await assets();
    const scores = (rev: string) =>
      BACKTEST_FILES.flatMap((name) => testRows(git("show", `${rev}:ml/results/backtest/${name}`)));
    const before = scores(`${joined}^`);
    const after = scores(joined);
    const models = [...new Set(after.map((row) => row.model))].filter((m) => before.some((row) => row.model === m));
    // a model whose error is identical at every horizon did not improve
    return models.filter((model) =>
      after.filter((row) => row.model === model).every((row) =>
        before.some((old) => old.model === model && old.horizon === row.horizon && old.maePct === row.maePct)));
  }

  const claim = /Every model on (?:that|this) table improved when the two FHFA columns joined/;
  const verdict = (text: string, still: string[]) =>
    claim.test(text) && still.length > 0
      ? `claims every model improved, while ${still.join(", ")} scored the same before and after`
      : "consistent";

  it("is on the model page only if no model's error stood still", async () => {
    expect(joined).toMatch(/^[0-9a-f]{40}$/);
    expect(verdict(PAGE, await unmoved())).toBe("consistent");
  });

  it("is in the ml README only if no model's error stood still", async () => {
    expect(verdict(read("ml/README.md").replace(/\s+/g, " "), await unmoved())).toBe("consistent");
  });
});

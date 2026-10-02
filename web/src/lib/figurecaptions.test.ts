// the alt text and captions the model page gives its figures, read against
// the files those figures are drawn from
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelPage } from "../components/ModelPage";
import { inWords, modelLabel, quantile, rowAt, SHIPPED } from "./model";
import { BACKTEST } from "./modelNumbers";
import { DEFAULT_ROUTE } from "./route";
import type { Shell } from "./views";
import type { MapData, Metro } from "../types";

const ROOT = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

const ASSETS = new URL("web/scripts/model-assets.mjs", ROOT).href;
type Row = Record<string, string>;
const csv = async (path: string) =>
  ((await import(ASSETS)) as { parseBacktest: (text: string) => Row[] }).parseBacktest(read(path));

const DATA = JSON.parse(read("web/public/data/metros.json")) as MapData;

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

const decode = (html: string) =>
  html.replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();

// what the rendered page gives each figure, keyed by the png it shows: the
// alt text a screen reader hears and the caption everybody reads
const FIGURE: Record<string, { alt: string; caption: string }> = {};
for (const block of renderToStaticMarkup(createElement(ModelPage, {
  data: DATA,
  route: { ...DEFAULT_ROUTE, view: "model" },
  go: () => {},
  viewport: { width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false },
  shell,
})).split("<figure").slice(1)) {
  const file = /src="\/figures\/([^"]+)"/.exec(block)?.[1];
  if (!file) continue;
  FIGURE[file] = {
    alt: decode(/alt="([^"]*)"/.exec(block)?.[1] ?? ""),
    caption: decode(/<figcaption>([\s\S]*?)<\/figcaption>/.exec(block)?.[1] ?? ""),
  };
}

// the prose convention the alt texts use for a signed percent
const said = (value: number) => `${value < 0 ? "minus" : "plus"} ${Math.abs(value).toFixed(1)}`;

// a qualitative claim may stand only while the numbers bear it out
const holds = (claimed: boolean, true_: boolean, what: string) => (claimed && !true_ ? what : "consistent");

const byName = (test: (m: Metro) => boolean) => DATA.metros.find(test)!;

describe("alt text quotes the shipped forecast and leaderboard", () => {
  it("marks the percentiles the forecast histogram draws, from forecasts.csv", async () => {
    const near = (await csv("ml/results/forecast/forecasts.csv"))
      .filter((r) => r.horizon === "4").map((r) => Number(r.q50_pct)).sort((a, b) => a - b);
    const { alt } = FIGURE["13_forecast_distribution.png"];
    const marks = [quantile(near, 0.1), quantile(near, 0.5), quantile(near, 0.9)].map(said);
    expect(marks.filter((mark) => !alt.includes(mark)), `alt: ${alt}`).toEqual([]);
  });

  it("says no bar sits below zero only when no metro is forecast to fall", async () => {
    const near = (await csv("ml/results/forecast/forecasts.csv"))
      .filter((r) => r.horizon === "4").map((r) => Number(r.q50_pct));
    const falling = near.filter((v) => v < 0).length;
    expect(holds(/No bar sits below zero/i.test(FIGURE["13_forecast_distribution.png"].alt), falling === 0,
      `says no bar sits below zero while ${falling} of ${near.length} metros are forecast to fall`)).toBe("consistent");
  });

  it("gives the fans' eight quarter bands for the Chicago division and Austin as forecasts.csv has them", async () => {
    const far = (await csv("ml/results/forecast/forecasts.csv")).filter((r) => r.horizon === "8");
    const at = (metro: Metro) => far.find((r) => r.cbsa_code === metro.cbsa)!;
    const chicago = at(byName((m) => m.level === "division" && m.name.startsWith("Chicago-")));
    const austin = at(byName((m) => m.name.startsWith("Austin-")));
    const { alt } = FIGURE["11_forecast_fans.png"];
    const numbers = [chicago.q50_pct, chicago.lo_pct, chicago.hi_pct, austin.lo_pct, austin.hi_pct].map((v) => said(Number(v)));
    expect(numbers.filter((n) => !alt.includes(n)), `alt: ${alt}`).toEqual([]);
  });

  it("puts every one of the strongest three inside the eight quarter range it states for them", () => {
    const { alt } = FIGURE["12_model_comparison.png"];
    const stated = [...alt.matchAll(/between (\d+(?:\.\d+)?) and (\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    // the three are read off the leaderboard, not named here: a retrain can change who they are
    const strongest = BACKTEST.filter((r) => r.horizon === 8 && Number.isFinite(r.maePct))
      .sort((a, b) => a.maePct - b.maePct).slice(0, 3);
    expect(strongest).toHaveLength(3);
    const outside = strongest
      .map(({ model, maePct }) => ({ model, mae: Number(maePct.toFixed(1)) }))
      .filter(({ mae }) => !stated.some(([lo, hi]) => mae >= lo && mae <= hi))
      .map(({ model, mae }) => `${model} ${mae}`);
    expect(outside, `alt: ${alt}`).toEqual([]);
    // and the three it names are those three
    const named = /the strongest three, (.+?), sit between/.exec(alt)?.[1]?.toLowerCase() ?? "";
    expect(strongest.filter((r) => !named.includes(modelLabel(r.model))).map((r) => r.model), `alt: ${alt}`).toEqual([]);
  });
});

describe("the coverage caption counts the series left of the rule", () => {
  // the figure is loop.panel.coverage_table over ml/data/panel.parquet, which
  // is untracked, so a clone without the built panel skips this
  const python = new URL("ml/.venv/bin/python", ROOT);
  const panel = new URL("ml/data/panel.parquet", ROOT);
  const script = [
    "import json",
    "import pandas as pd",
    "from loop import panel, spec",
    "table = panel.coverage_table(pd.read_parquet(spec.PANEL_PATH))",
    "fit = int(spec.FIT_END[:4])",
    "left = table.loc[:, [y for y in table.columns if y <= fit]]",
    "print(json.dumps([str(r) for r in table.index if float(left.loc[r].max()) == 0.0]))",
  ].join("\n");

  it.skipIf(!existsSync(python) || !existsSync(panel))("names as many empty series as the figure draws", () => {
    const empty = JSON.parse(execFileSync(fileURLToPath(python), ["-c", script], {
      cwd: fileURLToPath(new URL("ml/", ROOT)),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", MPLBACKEND: "Agg" },
      encoding: "utf8",
    })) as string[];
    const { caption } = FIGURE["01_coverage.png"];
    const count = /(\w+) series have nothing at all on the left of it/i.exec(caption)?.[1]?.toLowerCase();
    expect(count, `empty left of the rule: ${empty.join(", ")}`).toBe(inWords(empty.length));
  }, 60000);
});

describe("captions and alt text say what the calibration and comparison figures show", () => {
  it("says the strongest few converge at the long end only if they are closest there", () => {
    const spread = (h: number) => {
      const best = BACKTEST.filter((r) => r.horizon === h).map((r) => r.maePct).sort((a, b) => a - b).slice(0, 3);
      return best[best.length - 1] - best[0];
    };
    const shorter = [1, 2, 4].map(spread);
    expect(holds(/converge at the long end/i.test(FIGURE["12_model_comparison.png"].caption), spread(8) < Math.min(...shorter),
      `the best three sit ${spread(8).toFixed(2)} points apart at 8q against ${shorter.map((s) => s.toFixed(2)).join(", ")} at 1, 2 and 4q`))
      .toBe("consistent");
  });

  // the figure plots the share of test outcomes under each raw quantile; the
  // csv's coverage_raw is the share between q10 and q90, which is what a line
  // tilting or bowing off the diagonal loses against its nominal 0.80
  it("says the one and two quarter lines sit close to the diagonal only if they sit closer than eight's", async () => {
    const rows = (await csv("ml/results/backtest/seqgru.csv")).filter((r) => r.block === "test");
    const miss = (h: number) => 0.8 - Number(rows.find((r) => Number(r.horizon) === h)!.coverage_raw);
    const { alt } = FIGURE["10_quantile_calibration.png"];
    expect(holds(/one and two quarters the line sits close to the diagonal/i.test(alt), miss(1) < miss(8) && miss(2) < miss(8),
      `raw 10-90 band misses its 0.80 by ${miss(1).toFixed(3)} at 1q and ${miss(2).toFixed(3)} at 2q against ${miss(8).toFixed(3)} at 8q`))
      .toBe("consistent");
  });

  // the product's own reading of 0.87 at four quarters is "short of the nine
  // in ten it is built for" (the forecast explainer), so a band covering less
  // than that is not one that holds
  it("says the bands hold at short horizons only if they cover at least what four quarters does", () => {
    const cover = (h: number) => rowAt(BACKTEST, SHIPPED, h)!.coverage;
    expect(holds(/bands hold at short horizons/i.test(FIGURE["10_quantile_calibration.png"].caption),
      cover(1) >= cover(4) && cover(2) >= cover(4),
      `band coverage ${cover(1).toFixed(2)} at 1q and ${cover(2).toFixed(2)} at 2q against ${cover(4).toFixed(2)} at 4q`))
      .toBe("consistent");
  });
});

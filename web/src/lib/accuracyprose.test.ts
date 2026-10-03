// sentences the accuracy page states about the misses it scores, read against
// the shipped build and the repo's history
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccuracyPage } from "../components/AccuracyPage";
import { collectMisses, originOf } from "./accuracy";
import { quarterLabel } from "./model";
import { DEFAULT_ROUTE } from "./route";
import type { Shell } from "./views";
import type { MapData } from "../types";

const ROOT = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
const git = (...args: string[]) => execFileSync("git", args, { cwd: fileURLToPath(ROOT), encoding: "utf8" });

// the shipped build, not a fixture: 410 metros, the same file the site loads
const DATA = JSON.parse(read("web/public/data/metros.json")) as MapData;

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

const HTML = renderToStaticMarkup(createElement(AccuracyPage, {
  data: DATA,
  route: { ...DEFAULT_ROUTE, view: "accuracy" },
  go: () => {},
  viewport: { width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false },
  shell,
}));

const plain = (html: string) =>
  html.replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const PAGE = plain(HTML);
const MISSES = collectMisses(DATA.metros);

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe("which side of the call missed by more", () => {
  // the page's own convention, checked rather than assumed: the table headed
  // "beat the model" lists the metros whose miss is positive, the ones that
  // grew more than the model expected. "fell short" is the other side
  it("uses 'beat the model' for a positive miss, as section 2 does", () => {
    const table = /beat the model by the most<\/caption>([\s\S]*?)<\/table>/.exec(HTML)?.[1] ?? "";
    const shown = [...table.matchAll(/>([+-]?\d+\.\d) pp</g)].map((m) => Number(m[1]));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.filter((v) => v <= 0)).toEqual([]);
  });

  it("says beats ran larger than shortfalls only if they did, on average and at the extreme", () => {
    const beats = MISSES.filter((m) => m.surprise > 0).map((m) => m.surprise);
    const shortfalls = MISSES.filter((m) => m.surprise < 0).map((m) => -m.surprise);
    const beatsLarger = mean(beats) > mean(shortfalls) && Math.max(...beats) > Math.max(...shortfalls);
    const claimed = PAGE.includes("the metros that beat it missed by more than the metros that fell short");
    expect(claimed && !beatsLarger
      ? `says beats ran larger; mean beat ${mean(beats).toFixed(2)} vs mean shortfall ${mean(shortfalls).toFixed(2)} pp, `
        + `largest ${Math.max(...beats).toFixed(2)} vs ${Math.max(...shortfalls).toFixed(2)}`
      : "consistent").toBe("consistent");
  });

  it("says shortfalls ran larger than beats only if they did, on average and at the extreme", () => {
    const beats = MISSES.filter((m) => m.surprise > 0).map((m) => m.surprise);
    const shortfalls = MISSES.filter((m) => m.surprise < 0).map((m) => -m.surprise);
    const shortfallsLarger = mean(shortfalls) > mean(beats) && Math.max(...shortfalls) > Math.max(...beats);
    const claimed = PAGE.includes("the metros that fell short missed by more than the metros that beat it");
    expect(claimed && !shortfallsLarger ? "says shortfalls ran larger, and they did not" : "consistent").toBe("consistent");
  });
});

describe("the footer's 'counted twice, once whole and once in parts'", () => {
  it("is said only when a scored division's parent metro is scored too", () => {
    const scored = new Set(MISSES.map((m) => m.cbsa));
    const divisions = DATA.metros.filter((m) => m.level === "division" && scored.has(m.cbsa));
    const parents = [...new Set(divisions.map((m) => m.parent?.cbsa).filter((c): c is string => Boolean(c)))];
    const whole = parents.filter((code) => scored.has(code));
    const claimed = /counted twice, once whole and once in parts/.test(PAGE);
    expect(claimed && whole.length === 0
      ? `says places are counted twice; none of the ${parents.length} parents of the ${divisions.length} scored divisions is a scored row`
      : "consistent").toBe("consistent");
  });
});

describe("'a year ago the model published an expected four quarter growth'", () => {
  it("is said only if a forecast at the scored origin was ever published", () => {
    const made = quarterLabel(originOf(DATA.metros));
    // every origin a committed forecasts.csv has carried: what the model has
    // ever published, as opposed to what its backtest predicted after the fact
    const published = new Set(git("log", "--format=%H", "--", "ml/results/forecast/forecasts.csv").trim().split("\n")
      .flatMap((rev) => git("show", `${rev}:ml/results/forecast/forecasts.csv`).trim().split("\n").slice(1)
        .map((line) => line.split(",")[1])));
    const claimed = /A year ago the model published/.test(PAGE);
    expect(made).not.toBeNull();
    expect(claimed && !published.has(made as string)
      ? `says the model published its ${made} calls; the forecasts ever committed carry origin ${[...published].join(", ")} only`
      : "consistent").toBe("consistent");
  });
});

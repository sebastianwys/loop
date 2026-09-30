// a red test. run it on purpose:
//   cd web && npx vitest run --config redtest.config.ts src/lib/modelties.redtest.ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ModelPage } from "../components/ModelPage";
import { SHIPPED, lossSentence, lossesOf, rowAt, type BacktestRow } from "./model";
import { BACKTEST } from "./modelNumbers";
import { SAMPLE } from "./data";
import { DEFAULT_ROUTE } from "./route";
import type { Shell } from "./views";

const row = (model: string, horizon: number, maePct: number): BacktestRow =>
  ({ model, horizon, maePct, coverage: 0.9, width: 0.1, n: 100 });

describe("a tie in mean absolute error", () => {
  const tie = [row("ridge", 1, 1.8093), row(SHIPPED, 1, 1.8093), row("no_change", 1, 2.3)];
  const flipped = [tie[1], tie[0], tie[2]];

  it("is no defeat for either model, whichever row comes first", () => {
    expect(lossesOf(tie, SHIPPED)).toEqual([]);
    expect(lossesOf(flipped, SHIPPED)).toEqual([]);
    expect(lossesOf(tie, "ridge")).toEqual([]);
    expect(lossesOf(flipped, "ridge")).toEqual([]);
    expect(lossSentence(lossesOf(tie, SHIPPED))).not.toContain("0.00 points");
  });
});

// the model page over the shipped rows with the gru level with ridge at one
// quarter and at eight, in the order the csvs sort them and the other way
// round. a tie is neither side's win, so the order cannot change a verdict
describe("the model page on a tie", () => {
  const saved = BACKTEST.map((r) => ({ ...r }));
  afterEach(() => {
    BACKTEST.splice(0, BACKTEST.length, ...saved.map((r) => ({ ...r })));
  });

  const shell: Shell = {
    drawer: false, open: true, condensed: false, width: null,
    setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
  };
  const plain = (html: string) =>
    html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  // the readings and the limits, where the page says what the model wins and loses
  const verdicts = () => {
    const html = renderToStaticMarkup(createElement(ModelPage, {
      data: SAMPLE,
      route: { ...DEFAULT_ROUTE, view: "model" },
      go: () => {},
      viewport: { width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false },
      shell,
    }));
    const readings = html.slice(html.indexOf('<ul class="model-readings">'), html.indexOf("</ul>", html.indexOf('<ul class="model-readings">')));
    const limits = html.slice(html.indexOf("model-limits"), html.indexOf("</section>", html.indexOf("model-limits")));
    return { readings: plain(readings), limits: plain(limits) };
  };

  it("says the same thing about a tie in either row order", () => {
    for (const horizon of [1, 8]) rowAt(BACKTEST, SHIPPED, horizon)!.maePct = rowAt(BACKTEST, "ridge", horizon)!.maePct;
    expect(BACKTEST.findIndex((r) => r.model === "ridge")).toBeLessThan(BACKTEST.findIndex((r) => r.model === SHIPPED));
    const sorted = verdicts();
    BACKTEST.reverse();
    const reversed = verdicts();
    // "0.00 points away" names a tie and is true; "ahead by 0.00 points" calls it a defeat
    expect(sorted.readings).not.toMatch(/ahead at [a-z, ]+ by 0\.00 points/);
    expect(sorted.readings).toBe(reversed.readings);
    expect(sorted.limits).toBe(reversed.limits);
  });
});

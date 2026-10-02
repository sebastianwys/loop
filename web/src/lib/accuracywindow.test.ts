import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccuracyPage } from "../components/AccuracyPage";
import { dateAt } from "./metrics";
import { DEFAULT_ROUTE } from "./route";
import { dateLabel } from "./timeline";
import type { Shell } from "./views";
import type { MapData } from "../types";

const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

const plain = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const datesOf = (field: string) =>
  [...new Set(data!.metros.map((m) => dateAt(m, "latest", field)).filter((d): d is string => d !== null))].sort();

describe.skipIf(!present)("the window the accuracy page's growth figures cover", () => {
  it("runs from the origin the page prints to the quarter the growth is dated at", () => {
    // every scored call is dated at the quarter it was made, and the growth it
    // is scored against at the quarter four on from there
    expect(datesOf("hpi_surprise_4q")).toEqual(["2025-06"]);
    expect(datesOf("hpi_yoy_latest")).toEqual(["2026-06"]);

    const page = plain(renderToStaticMarkup(createElement(AccuracyPage, {
      data: data!,
      route: { ...DEFAULT_ROUTE, view: "accuracy" },
      go: () => {},
      viewport: { width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false },
      shell,
    })));
    expect(page).toContain(`origin ${dateLabel("2025-06")}`);

    const foot = /Growth figures are percent change in the FHFA index over the four quarters [^.]*\./.exec(page)?.[0];
    expect(foot, "no growth window sentence").toBeDefined();
    expect(foot, "the window is placed before the origin the page prints").not.toMatch(/to the origin/);
    expect(foot, "the window does not reach the quarter the growth is dated at").toContain(dateLabel("2026-06")!);
  });
});

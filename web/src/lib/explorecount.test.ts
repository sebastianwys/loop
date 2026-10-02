import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExplorePage } from "../components/ExplorePage";
import { SAMPLE } from "./data";
import { DEFAULT_ROUTE } from "./route";
import type { Shell } from "./views";
import type { MapData } from "../types";

const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const shipped: MapData | null = existsSync(PATH) ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

const shell: Shell = {
  drawer: false, open: true, condensed: false, width: null,
  setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
};

const page = (data: MapData) => renderToStaticMarkup(createElement(ExplorePage, {
  data,
  route: { ...DEFAULT_ROUTE, view: "explore" },
  go: () => {},
  viewport: { width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false },
  shell,
})).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

afterEach(() => vi.unstubAllGlobals());

describe("the explore page's caution about independent samples", () => {
  it("counts the metros the page was rendered from", () => {
    vi.stubGlobal("window", { location: { search: "" } });
    const text = page(SAMPLE);
    expect(text).toContain("2 of 3 metros are drawn");
    expect(text).toContain("The 3 metros here are not 3 independent samples");
    expect(text).not.toContain("410");
  });

  it.skipIf(!shipped)("still counts 410 on the shipped build", () => {
    vi.stubGlobal("window", { location: { search: "" } });
    expect(page(shipped!)).toContain(`The ${shipped!.metros.length} metros here are not ${shipped!.metros.length} independent samples`);
  });
});

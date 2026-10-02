// the index standard error prints at the precision fhfa publishes it in
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelPage } from "../components/ModelPage";
import { formatValue } from "./format";
import { defById, fieldAt } from "./metrics";
import { DEFAULT_ROUTE } from "./route";
import type { Shell } from "./views";
import type { MapData } from "../types";

const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

// fhfa's expanded-data file, where the error comes from, in percent of the index
const EXPANDED = new URL("../../../data/raw/fhfa/hpi_exp_metro.txt", import.meta.url).pathname;
const published = existsSync(EXPANDED);

// what the map, the ranking, the legend and the detail panel print for it
const printed = (value: number) => formatValue(value, defById("hpi_index_error")!.def.format);
const digits = (text: string) => text.replace(/[^0-9.]/g, "");

describe.skipIf(!present)("the index standard error on the map", () => {
  it("never prints a nonzero error as zero", () => {
    const zeros = data!.metros.flatMap((m) => {
      const value = fieldAt(m, "latest", "hpi_index_error");
      return value !== null && value > 0 && Number(digits(printed(value))) === 0 ? [`${m.name} ${value} as ${printed(value)}`] : [];
    });
    expect(zeros.length, `first: ${zeros.slice(0, 3).join("; ")}`).toBe(0);
  });
});

// the rebuild ships fhfa's own relative standard error, which fhfa publishes
// in hundredths: denver 0.34, phoenix 0.31. the precision has to keep apart
// the values fhfa keeps apart, or the tightest metros read as one number
describe.skipIf(!present || !published)("the errors fhfa publishes at the newest quarter", () => {
  it("print apart wherever fhfa's own figures differ", () => {
    const rows = readFileSync(EXPANDED, "utf8").trim().split("\n").slice(1).map((line) => line.split("\t"));
    const quarter = (r: string[]) => Number(r[2]) * 10 + Number(r[3]);
    const newest = Math.max(...rows.map(quarter));
    const codes = new Set(data!.metros.map((m) => m.cbsa));
    const values = [...new Set(rows
      .filter((r) => quarter(r) === newest && codes.has(r[0].padStart(5, "0")) && r[6] !== "")
      .map((r) => Number(r[6])))].sort((a, b) => a - b);
    expect(values.length).toBeGreaterThan(100);
    const merged: string[] = [];
    for (let i = 1; i < values.length; i++) {
      if (printed(values[i]) === printed(values[i - 1])) merged.push(`${values[i - 1]} and ${values[i]} as ${printed(values[i])}`);
    }
    expect(merged.length, `first: ${merged.slice(0, 3).join("; ")}`).toBe(0);
  });
});

describe.skipIf(!present)("one field, one number on every page", () => {
  it("prints the model page's two named errors the way the map prints them", () => {
    const shell: Shell = {
      drawer: false, open: true, condensed: false, width: null,
      setOpen: () => {}, resize: () => {}, commit: () => {}, reset: () => {}, measure: () => 320,
    };
    const text = renderToStaticMarkup(createElement(ModelPage, {
      data: data!,
      route: { ...DEFAULT_ROUTE, view: "model" },
      go: () => {},
      viewport: { width: 1440, height: 900, mode: "wide", coarse: false, reducedMotion: false },
      shell,
    })).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    const named = /between (.+?) measured to within ([0-9.]+) percent and (.+?) measured to within ([0-9.]+) percent/.exec(text);
    expect(named, "the model page names no tightest and loosest metro").not.toBeNull();
    const [, lowName, lowText, highName, highText] = named!;
    const value = (name: string) => fieldAt(data!.metros.find((m) => m.name === name)!, "latest", "hpi_index_error")!;
    expect(digits(printed(value(lowName))), `${lowName} on the map`).toBe(lowText);
    expect(digits(printed(value(highName))), `${highName} on the map`).toBe(highText);
  });
});

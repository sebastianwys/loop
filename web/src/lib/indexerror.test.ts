import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DetailPanel } from "../components/DetailPanel";
import { formatValue } from "./format";
import { defById } from "./metrics";
import type { MapData, Metro } from "../types";

// the built json is optional in ci, so this suite skips when it is absent
const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

const panel = (metro: Metro) =>
  renderToStaticMarkup(createElement(DetailPanel, { metro, metros: data!.metros, onClose: () => {} }));

const error = (metro: Metro): number | null => {
  const value = (metro.latest as unknown as Record<string, unknown>)?.hpi_index_error;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

// the index standard error is registered in the Forecasts group with the note
// that "a wide error here is a reason to read the forecast above it loosely"
// (metrics.ts). the detail panel keeps every Forecasts definition out of its
// Latest table, since the forecasts have a section of their own, so that
// section has to show it, or the one FHFA number in the group falls through
// both tables
describe.skipIf(!present)("the index standard error in a metro's detail panel", () => {
  const def = defById("hpi_index_error")!.def;

  it("is shown for cleveland, which carries one", () => {
    const cleveland = data!.metros.find((m) => m.cbsa === "17410")!;
    expect(error(cleveland)).not.toBeNull();
    const markup = panel(cleveland);
    // the forecast it is meant to sit beside is in the panel
    expect(markup).toContain("Expected HPI growth, next 4 quarters");
    expect(markup).toContain(def.label);
    expect(markup).toContain(formatValue(error(cleveland), def.format));
  });

  it("is shown for every metro that carries one", () => {
    const carrying = data!.metros.filter((m) => error(m) !== null);
    expect(carrying).toHaveLength(410);
    const silent = carrying.filter((m) => !panel(m).includes(def.label)).length;
    expect(silent, "metros whose panel leaves out the index standard error").toBe(0);
  });
});

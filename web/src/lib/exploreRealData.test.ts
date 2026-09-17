import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildExplore, exploreEnds, plotSize, plottedSentence } from "./explore";
import { exploreMetric } from "./exploreRoute";
import { availablePeriods, defById, isInherited, resolveMetric, visibleDefs } from "./metrics";
import { DEFAULT_ROUTE, routeMetric } from "./route";
import type { MapData } from "../types";

// the built json is optional in ci, so this suite skips when it is absent
const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;
const size = plotSize("wide");

describe.skipIf(!present)("the explore view over the built metros.json", () => {
  it("plots every pair of visible metrics without putting a dot outside the box or a NaN in the address", () => {
    const metros = data!.metros;
    const y = resolveMetric(defById("hpi_forecast_4q")!.def, "latest");
    for (const def of visibleDefs(metros)) {
      const periods = def.periods.length ? availablePeriods(def, metros) : [null];
      for (const period of periods) {
        const x = resolveMetric(def, period);
        const model = buildExplore(metros, x, y, size);
        for (const point of model.points) {
          expect(Number.isFinite(point.cx) && Number.isFinite(point.cy), x.id).toBe(true);
          expect(point.cx, x.id).toBeGreaterThanOrEqual(model.left - 0.1);
          expect(point.cx, x.id).toBeLessThanOrEqual(model.right + 0.1);
          expect(point.cy, x.id).toBeLessThanOrEqual(model.bottom + 0.1);
          expect(point.cy, x.id).toBeGreaterThanOrEqual(model.top - 0.1);
        }
        expect(model.counts.plotted + model.counts.missing, x.id).toBe(metros.length);
        if (model.fit) expect(Math.abs(model.fit.r), x.id).toBeLessThanOrEqual(1);
      }
    }
  });

  it("takes the log of the metrics that span orders of magnitude and leaves the rates and shares alone", () => {
    const metros = data!.metros;
    const at = (id: string, period: "latest" | "2024") => resolveMetric(defById(id)!.def, period);
    const scaleOf = (id: string, period: "latest" | "2024") =>
      buildExplore(metros, at(id, period), at(id, period), size).x.scale;
    for (const id of ["pop_estimate", "active_listings", "permits_units", "bea_personal_income"]) {
      expect(scaleOf(id, "latest"), id).toBe("log");
    }
    for (const id of ["unemp", "zhvi", "median_listing_price", "days_on_market"]) {
      expect(scaleOf(id, "latest"), id).toBe("linear");
    }
    expect(scaleOf("income", "2024")).toBe("linear");
  });

  it("never takes the log of a metric that goes negative, however lopsided it is", () => {
    const metros = data!.metros;
    for (const id of ["domestic_migration", "net_migration", "natural_change", "irs_net_exemptions"]) {
      const metric = resolveMetric(defById(id)!.def, "latest");
      expect(buildExplore(metros, metric, metric, size).x.scale, id).toBe("linear");
    }
  });

  it("holds the 37 metropolitan divisions out of the line when a metric is one they take from a parent", () => {
    const metros = data!.metros;
    const x = resolveMetric(defById("active_listings")!.def, "latest");
    const y = resolveMetric(defById("pop_estimate")!.def, "latest");
    const model = buildExplore(metros, x, y, size);
    const taken = metros.filter((m) => isInherited(m, x)).length;
    expect(taken).toBe(37);
    expect(model.counts.plotted).toBe(metros.length);
    expect(model.counts.inherited).toBe(taken);
    expect(model.fit!.n).toBe(metros.length - taken);
    const ends = exploreEnds(model);
    for (const point of [...ends.xHigh, ...ends.xLow, ...ends.yHigh, ...ends.yLow]) {
      expect(point.inherited).toBe(false);
    }
  });

  it("counts out loud the metros the pair the view opens on cannot draw", () => {
    const metros = data!.metros;
    const x = routeMetric({ ...DEFAULT_ROUTE, view: "explore" }, metros);
    const y = exploreMetric({ y: null, period: null }, metros, x.def.id);
    const model = buildExplore(metros, x.metric, y.metric, size);
    expect(model.counts.total).toBe(410);
    expect(model.counts.plotted).toBeLessThan(model.counts.total);
    expect(model.counts.plotted).toBeGreaterThan(300);
    // the 37 divisions have no permitting rate of their own: their permits are
    // the parent metro's and their population is theirs, and metrics.ts
    // refuses to divide one geography by another
    expect(model.counts.missingY).toBe(37);
    expect(plottedSentence(model.counts, x.metric.label, y.metric.label)).toContain(`${model.counts.plotted} of 410`);
    expect(model.fit!.n).toBe(model.counts.plotted);
  });
});

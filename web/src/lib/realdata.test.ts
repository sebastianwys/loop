import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildHistory, forecastOf } from "./history";
import { INDICATOR_GROUPS, groupIndicators, indicatorSpark, monthLabel, nationalIndicators } from "./indicators";
import { DEFS, METRICS, availablePeriods, resolveMetric, visibleDefs } from "./metrics";
import { rankMetros } from "./rank";
import { buildScale } from "./scale";
import { buildTimeline } from "./timeline";
import type { MapData } from "../types";

// the built json is optional in ci, so this suite skips when it is absent
const PATH = new URL("../../public/data/metros.json", import.meta.url).pathname;
const present = existsSync(PATH);
const data: MapData | null = present ? (JSON.parse(readFileSync(PATH, "utf8")) as MapData) : null;

describe.skipIf(!present)("built metros.json", () => {
  it("has the study shape", () => {
    expect(data!.years).toEqual([2014, 2019, 2024]);
    expect(data!.metros.length).toBeGreaterThan(300);
    for (const m of data!.metros) {
      expect(m.cbsa).toMatch(/^\d{5}$/);
      expect(Number.isFinite(m.lat) && Number.isFinite(m.lon)).toBe(true);
    }
  });

  it("builds a five class scale at every available period of every visible metric", () => {
    const visible = visibleDefs(data!.metros);
    expect(visible.length).toBeGreaterThan(30);
    for (const def of visible) {
      const periods = def.periods.length ? availablePeriods(def, data!.metros) : [null];
      expect(periods.length, def.id).toBeGreaterThan(0);
      for (const period of periods) {
        const metric = resolveMetric(def, period);
        const values = data!.metros.map(metric.accessor);
        const scale = buildScale(values, metric.kind);
        expect(scale.bins, metric.id).toHaveLength(5);
        for (const bin of scale.bins) {
          expect(Number.isFinite(bin.from) && Number.isFinite(bin.to), metric.id).toBe(true);
        }
        const covered = values.filter((v) => v !== null).length;
        expect(covered, `${metric.id} coverage`).toBeGreaterThan(data!.metros.length / 2);
      }
    }
  });

  // the metric the site opens on, which is the one map most readers will ever
  // see. it is declared diverging and no metro is on the losing side of it, so
  // a symmetric ramp spends two of its five classes on a half of the axis that
  // holds nobody and the legend still advertises them
  it("fills every class it advertises on the metric the site opens on", () => {
    const metric = resolveMetric(DEFS[0], null);
    const values = data!.metros.map(metric.accessor);
    const scale = buildScale(values, metric.kind);
    expect(scale.kind).toBe("sequential");
    expect(scale.bins).toHaveLength(5);
    for (const bin of scale.bins) {
      const inside = values.filter((v) => v !== null && v >= bin.from && v <= bin.to);
      expect(inside.length, `${bin.from} to ${bin.to}`).toBeGreaterThan(0);
    }
  });

  // bea and hud wait on a key, the forecast on an export run of the model
  it("hides only the sources that have not been collected", () => {
    const hidden = DEFS.filter((d) => !visibleDefs(data!.metros).includes(d)).map((d) => d.source);
    for (const source of hidden) expect(["bea", "hud", "forecast"]).toContain(source);
  });

  it("ranks the core metric across most metros", () => {
    const ranked = rankMetros(data!.metros, METRICS[0]);
    expect(ranked.length).toBeGreaterThan(300);
    expect(ranked[0].value).toBeGreaterThanOrEqual(ranked[ranked.length - 1].value);
  });

  it("builds a timeline for every visible metric whose filled ticks are the periods with data", () => {
    for (const def of visibleDefs(data!.metros)) {
      const model = buildTimeline(def, data!.metros);
      if (def.periods.length === 0) {
        expect(model.ticks, def.id).toEqual([]);
        expect(model.span, def.id).not.toBeNull();
        continue;
      }
      expect(model.ticks, def.id).toHaveLength(4);
      expect(model.ticks.filter((t) => t.available).map((t) => t.period), def.id).toEqual(availablePeriods(def, data!.metros));
      const latest = model.ticks[3];
      if (latest.available) {
        expect(latest.date, def.id).not.toBeNull();
        expect(latest.label, def.id).not.toBe("latest");
        expect(latest.t, def.id).toBeLessThanOrEqual(1);
      }
    }
  });

  // the annual history is optional until the bot writes it, so this only
  // checks the shape of what is there
  it("carries a well formed hpi series where one is present", () => {
    for (const m of data!.metros) {
      const series = m.series?.hpi;
      if (!series) continue;
      // the builder floors at 1975, where fhfa's quarterly metro series begins,
      // and each metro starts at its own first drawable year after that
      expect(Number.isInteger(series.start) && series.start >= 1975, m.cbsa).toBe(true);
      expect(series.values.length, m.cbsa).toBeGreaterThan(0);
      for (const v of series.values) expect(v === null || Number.isFinite(v), m.cbsa).toBe(true);
      expect(typeof series.as_of === "string" && series.as_of.length > 0, m.cbsa).toBe(true);
      const history = buildHistory(series, forecastOf(m));
      for (const p of [...history.points, ...history.forecast]) expect(Number.isFinite(p.x) && Number.isFinite(p.y), m.cbsa).toBe(true);
    }
  });

  // the national indicators are optional until the bot collects them, so
  // this only checks that the strip can read what is there
  it("carries national indicators the strip can draw, where the block is present", () => {
    const raw = data!.national?.indicators;
    if (!raw) return;
    const read = nationalIndicators(data!);
    expect(read.length, "every entry is readable").toBe(raw.length);
    for (const i of read) {
      expect(INDICATOR_GROUPS, i.id).toContain(i.group);
      expect(["pct", "rate", "index"], i.id).toContain(i.format);
      expect(monthLabel(i.date), i.id).not.toBe("");
      // the trim used to be five years and is now the series' own length, so
      // the useful guard is that the history is real and ends where the tile
      // says it does, not that it is short
      expect(i.history.length, i.id).toBeGreaterThan(0);
      expect(i.history[i.history.length - 1].date, i.id).toBe(i.date);
      const dates = i.history.map((p) => p.date);
      expect([...dates].sort(), i.id).toEqual(dates);
      expect(new Set(dates).size, i.id).toBe(dates.length);
      for (const p of i.history) expect(monthLabel(p.date), i.id).not.toBe("");
      const spark = indicatorSpark(i.history);
      if (spark) for (const p of spark.points) expect(Number.isFinite(p.x) && Number.isFinite(p.y), i.id).toBe(true);
    }
    expect(groupIndicators(read).map((b) => b.group)).toEqual(INDICATOR_GROUPS.filter((g) => read.some((i) => i.group === g)));
  });
});

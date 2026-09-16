import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapData } from "../types";

// the loader substitutes a three metro fixture for the real build, and the
// header only says so if the flag comes back true. nothing asserted that
describe("loadMapData", () => {
  async function fresh() {
    vi.resetModules();
    return await import("./data");
  }

  const built = { metros: [{ cbsa: "10180" }, { cbsa: "16984" }], national: {} } as unknown as MapData;
  const respond = (body: unknown, ok = true) =>
    Promise.resolve({ ok, json: async () => body } as unknown as Response);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the built file and does not flag the sample", async () => {
    vi.stubGlobal("fetch", vi.fn(() => respond(built)));
    const mod = await fresh();
    const { data, sample } = await mod.loadMapData();
    expect(sample).toBe(false);
    expect(data.metros).toHaveLength(2);
  });

  it("flags the sample when the file is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => respond(null, false)));
    const mod = await fresh();
    const { data, sample } = await mod.loadMapData();
    expect(sample).toBe(true);
    expect(data).toBe(mod.SAMPLE);
  });

  it("flags the sample when the fetch never lands", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    const mod = await fresh();
    expect((await mod.loadMapData()).sample).toBe(true);
  });

  // a build that wrote something other than a metro array is the case worth
  // catching: it looks like data and would draw an empty map
  it("flags the sample when the json is not a build", async () => {
    for (const body of [{}, { metros: {} }, { metros: null }, [], "not json at all"]) {
      vi.stubGlobal("fetch", vi.fn(() => respond(body)));
      const mod = await fresh();
      const { data, sample } = await mod.loadMapData();
      expect(sample, JSON.stringify(body)).toBe(true);
      expect(data).toBe(mod.SAMPLE);
    }
  });

  // the substitution is only safe because the fixture is a real build shape
  it("the fixture it falls back to is usable", async () => {
    const mod = await fresh();
    expect(Array.isArray(mod.SAMPLE.metros)).toBe(true);
    expect(mod.SAMPLE.metros.length).toBeGreaterThan(0);
    for (const metro of mod.SAMPLE.metros) expect(metro.cbsa).toMatch(/^\d{5}$/);
  });
});

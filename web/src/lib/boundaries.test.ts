import type { Topology } from "topojson-specification";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NULL_FILL_OPACITY,
  SHAPE_FILL_OPACITY,
  WITHHELD_FILL_OPACITY,
  decodeBoundaries,
  featureFor,
  markStyle,
  shapeStyle,
  studyShapes,
} from "./boundaries";
import { INK, INK_2, NULL_GRAY, SEQUENTIAL, SURFACE } from "./palette";
import { buildScale } from "./scale";
import { tooltipContent } from "../components/ShapeLayer";
import { SAMPLE } from "./data";
import { defById, metricById, resolveMetric } from "./metrics";
import type { Metro } from "../types";

// the shape layer reads window through leaflet at import, and its tooltip is
// all this file needs from it, so the map library is stubbed out
vi.mock("leaflet", () => ({}));
vi.mock("react-leaflet", () => ({ useMap: () => ({}) }));

// one square arc shared by a metro and a division, no quantization transform
const topology: Topology = {
  type: "Topology",
  arcs: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
  objects: {
    cbsa: {
      type: "GeometryCollection",
      geometries: [
        { type: "Polygon", arcs: [[0]], properties: { GEOID: "10180", NAME: "Abilene, TX" } },
        { type: "Polygon", arcs: [[0]], properties: { GEOID: "99999", NAME: "Not in the study" } },
      ],
    },
    metdiv: {
      type: "GeometryCollection",
      geometries: [
        { type: "Polygon", arcs: [[0]], properties: { GEOID: "16984", NAME: "Chicago-Naperville-Schaumburg, IL" } },
      ],
    },
  },
};

const metro = (cbsa: string, level?: "msa" | "division") =>
  ({ cbsa, name: cbsa, level, lat: 0, lon: 0 }) as unknown as Metro;

describe("decodeBoundaries", () => {
  it("keys each object by its five digit code and decodes the geometry", () => {
    const index = decodeBoundaries(topology);
    expect([...index.cbsa.keys()]).toEqual(["10180", "99999"]);
    expect([...index.metdiv.keys()]).toEqual(["16984"]);
    const abilene = index.cbsa.get("10180");
    expect(abilene?.properties.NAME).toBe("Abilene, TX");
    expect(abilene?.geometry.type).toBe("Polygon");
    expect((abilene?.geometry as { coordinates: number[][][] }).coordinates[0]).toHaveLength(5);
  });

  it("gives an empty map for a missing object instead of throwing", () => {
    const only = { ...topology, objects: { cbsa: topology.objects.cbsa } } as Topology;
    const index = decodeBoundaries(only);
    expect(index.cbsa.size).toBe(2);
    expect(index.metdiv.size).toBe(0);
  });
});

describe("featureFor", () => {
  const index = decodeBoundaries(topology);

  it("uses the cbsa object for a metro and the metdiv object for a division", () => {
    expect(featureFor(metro("10180", "msa"), index)?.properties.GEOID).toBe("10180");
    expect(featureFor(metro("16984", "division"), index)?.properties.GEOID).toBe("16984");
  });

  it("treats a metro without a level as a cbsa", () => {
    expect(featureFor(metro("10180"), index)?.properties.NAME).toBe("Abilene, TX");
  });

  it("returns null for a code with no feature and never crosses objects", () => {
    expect(featureFor(metro("00000", "msa"), index)).toBeNull();
    expect(featureFor(metro("16984", "msa"), index)).toBeNull();
    expect(featureFor(metro("10180", "division"), index)).toBeNull();
  });
});

describe("studyShapes", () => {
  it("draws only the study's metros, in study order", () => {
    const index = decodeBoundaries(topology);
    const shapes = studyShapes([metro("16984", "division"), metro("10180", "msa"), metro("00000", "msa")], index);
    expect(shapes.map((s) => s.metro.cbsa)).toEqual(["16984", "10180"]);
    expect(shapes.map((s) => s.feature.properties.GEOID)).toEqual(["16984", "10180"]);
  });

  it("is empty when nothing matches", () => {
    expect(studyShapes([metro("00000")], decodeBoundaries(topology))).toEqual([]);
  });
});

describe("shapeStyle, a value taken from the parent metro", () => {
  const scale = buildScale([0, 10], "sequential");

  // the number is real. it just belongs to a bigger place. the fill keeps the
  // value so the map still reads, and the outline carries the provenance
  it("keeps the colour but marks the outline", () => {
    const own = shapeStyle(10, scale);
    const taken = shapeStyle(10, scale, { inherited: true });
    expect(taken.fillColor).toBe(own.fillColor);
    expect(taken.color).not.toBe(own.color);
    expect(taken.dashArray).toBeDefined();
  });

  // no data already owns "3 3" on the null gray. inherited must not collide
  it("does not wear the no data mark", () => {
    const none = shapeStyle(null, scale);
    const taken = shapeStyle(10, scale, { inherited: true });
    expect(taken.dashArray).not.toBe(none.dashArray);
    expect(taken.color).not.toBe(none.color);
    expect(taken.fillColor).not.toBe(none.fillColor);
  });

  // a 4px dot cannot show a dash, so the fill weight has to carry it too
  it("sits between measured and missing on fill", () => {
    const taken = shapeStyle(10, scale, { inherited: true });
    expect(taken.fillOpacity).toBeLessThan(SHAPE_FILL_OPACITY);
    expect(taken.fillOpacity).toBeGreaterThan(NULL_FILL_OPACITY);
  });

  // selection is the stronger signal and still wins
  it("yields to the selected outline", () => {
    const taken = shapeStyle(10, scale, { inherited: true, selected: true });
    expect(taken.dashArray).toBeUndefined();
  });

  it("is ignored when there is no value to attribute", () => {
    expect(shapeStyle(null, scale, { inherited: true })).toEqual(shapeStyle(null, scale));
  });
});

// a number the build withheld is a different claim from one nobody measured,
// so the two blanks never share a mark
// the dots tooltip names the parent a division's number belongs to, and the
// shape drawn for the same number says the same thing
describe("a shape's tooltip on a number taken from the parent metro", () => {
  // just enough of a document for a tooltip built with textContent
  class Node {
    children: Node[] = [];
    className = "";
    constructor(private own = "") {}
    get textContent(): string {
      return this.children.length ? this.children.map((c) => c.textContent).join("") : this.own;
    }
    set textContent(value: string) {
      this.own = value;
      this.children = [];
    }
    append(...nodes: Node[]) {
      this.children.push(...nodes);
    }
  }

  afterEach(() => vi.unstubAllGlobals());

  it("names the parent, and says nothing of one on a metro's own number", () => {
    vi.stubGlobal("document", { createElement: () => new Node(), createTextNode: (text: string) => new Node(text) });
    const metric = resolveMetric(defById("permits_units")!.def, "latest");
    const division = SAMPLE.metros[2];
    expect(division.parent_metrics).toContain("permits_units");
    const taken = tooltipContent(division, metric).textContent;
    expect(taken).toContain(`from ${division.parent!.name}`);
    expect(tooltipContent(SAMPLE.metros[0], metric).textContent).not.toContain("from ");
  });

  // a blank the build withheld reads withheld in the shape's tooltip, with why,
  // where a blank nobody measured keeps the dash, as the dots tooltip does
  it("says withheld for a blank the build withheld, and the dash for one nobody measured", () => {
    vi.stubGlobal("document", { createElement: () => new Node(), createTextNode: (text: string) => new Node(text) });
    const abilene = SAMPLE.metros[0];
    const blank = { ...abilene.growth, income_14_24: null };
    const income = metricById("income_14_24");
    const refused: Metro = { ...abilene, growth: blank, footprint_refused: 0.047 };
    expect(tooltipContent(refused, income).textContent).toBe("Abilene, TX withheld 2014 to 2024, county lines moved");
    expect(tooltipContent({ ...abilene, growth: blank }, income).textContent).toBe("Abilene, TX - 2014 to 2024");

    const permits = metricById("permits_per_1000_2014");
    const marked: Metro = { ...abilene, years: { ...abilene.years, "2014": { ...abilene.years["2014"], permits_footprint: 0.378 } } };
    expect(tooltipContent(marked, permits).textContent).toBe("Abilene, TX withheld 2014, counted over different counties");
  });
});

describe("shapeStyle, a value the build withheld", () => {
  const scale = buildScale([0, 10], "sequential");

  it("is hollow like no data but ringed solid in ink", () => {
    const none = shapeStyle(null, scale);
    const withheld = shapeStyle(null, scale, { withheld: true });
    expect(withheld.fillColor).toBe(none.fillColor);
    expect(withheld.color).toBe(INK_2);
    expect(withheld.color).not.toBe(none.color);
    expect(withheld.dashArray).toBeUndefined();
    expect(withheld.fillOpacity).toBe(WITHHELD_FILL_OPACITY);
  });

  it("does not wear the inherited mark either", () => {
    const taken = shapeStyle(10, scale, { inherited: true });
    const withheld = shapeStyle(null, scale, { withheld: true });
    expect(withheld.dashArray).not.toBe(taken.dashArray);
    expect(withheld.fillColor).not.toBe(taken.fillColor);
  });

  it("is ignored when the value is there", () => {
    expect(shapeStyle(10, scale, { withheld: true })).toEqual(shapeStyle(10, scale));
  });

  it("gives a dot the same marks through markStyle", () => {
    expect(markStyle(true, false, true)).toEqual({ color: INK_2, dashArray: undefined, fillOpacity: WITHHELD_FILL_OPACITY });
    expect(markStyle(true, false, false).dashArray).toBe("3 3");
  });
});

describe("shapeStyle", () => {
  const scale = buildScale([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "sequential");

  it("fills a number with the scale color under a surface hairline", () => {
    const style = shapeStyle(10, scale);
    expect(style.fillColor).toBe(SEQUENTIAL[4]);
    expect(style.fillOpacity).toBe(SHAPE_FILL_OPACITY);
    expect(style.color).toBe(SURFACE);
    expect(style.weight).toBe(1);
    expect(style.dashArray).toBeUndefined();
  });

  it("marks null with gray, low opacity and a dashed stroke, not color alone", () => {
    const style = shapeStyle(null, scale);
    expect(style.fillColor).toBe(NULL_GRAY);
    expect(style.fillOpacity).toBe(NULL_FILL_OPACITY);
    expect(style.dashArray).toBe("3 3");
    expect(style.color).toBe(NULL_GRAY);
  });

  it("treats a non finite value as null", () => {
    expect(shapeStyle(Number.NaN, scale).fillColor).toBe(NULL_GRAY);
  });

  it("lifts on hover and outlines the selected shape in ink", () => {
    const hover = shapeStyle(5, scale, { hover: true });
    expect(hover.color).toBe(INK_2);
    expect(hover.fillOpacity).toBeGreaterThan(SHAPE_FILL_OPACITY);
    const selected = shapeStyle(null, scale, { selected: true, hover: true });
    expect(selected.color).toBe(INK);
    expect(selected.weight).toBe(2.5);
    expect(selected.dashArray).toBeUndefined();
  });

  it("stays gray when the whole scale is empty", () => {
    expect(shapeStyle(3, buildScale([null], "sequential")).fillColor).toBe(NULL_GRAY);
  });
});

// the module caches the fetched index. a fetch that failed is not an index,
// and caching it means the shapes view is dead for the life of the page
describe("loadBoundaries", () => {
  const ok = () => Promise.resolve({ ok: true, json: async () => topology } as unknown as Response);

  async function fresh() {
    vi.resetModules();
    return await import("./boundaries");
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches once and reuses the index", async () => {
    const fetchMock = vi.fn(ok);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await fresh();
    const first = await mod.loadBoundaries();
    const second = await mod.loadBoundaries();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first?.cbsa.size).toBe(2);
    expect(second).toBe(first);
  });

  it("retries after a network failure instead of answering null forever", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(ok);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await fresh();
    expect(await mod.loadBoundaries()).toBeNull();
    const second = await mod.loadBoundaries();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second?.cbsa.size).toBe(2);
  });

  it("retries after a bad response as well", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response)
      .mockImplementation(ok);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await fresh();
    expect(await mod.loadBoundaries()).toBeNull();
    expect(await mod.loadBoundaries()).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // two callers asking while one fetch is in flight share it
  it("does not fetch twice for two callers at once", async () => {
    const fetchMock = vi.fn(ok);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await fresh();
    const [a, b] = await Promise.all([mod.loadBoundaries(), mod.loadBoundaries()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});

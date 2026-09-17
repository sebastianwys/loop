import { describe, expect, it } from "vitest";
import {
  DASHES, MARKERS, MAX_COMPARE, buildCompare, chartSize, chooseMetros, columnX, compareTitle, markerPath,
  nearestYear, readingAt, shortLabel, spreadLabels, toggleCompare, type CompareEntry,
} from "./compare";
import { SAMPLE } from "./data";
import type { AnnualSeries } from "../types";

const series = (start: number, values: (number | null)[]): AnnualSeries => ({ start, values, as_of: `${start + values.length - 1}Q4` });

const entry = (cbsa: string, name: string, s: AnnualSeries): CompareEntry => ({ cbsa, name, series: s });

const wide = chartSize("wide");

describe("choosing the metros to compare", () => {
  it("keeps the order they were picked in", () => {
    expect(chooseMetros(["19100", "10180"], SAMPLE.metros).map((m) => m.cbsa)).toEqual(["19100", "10180"]);
  });

  it("drops a code the build does not carry, and a repeat of one it does", () => {
    expect(chooseMetros(["10180", "99999", "10180"], SAMPLE.metros).map((m) => m.cbsa)).toEqual(["10180"]);
    expect(chooseMetros([], SAMPLE.metros)).toEqual([]);
  });

  it("stops at the fourth", () => {
    const many = ["10180", "19100", "25980", "10180", "19100"];
    expect(chooseMetros(many, SAMPLE.metros).length).toBeLessThanOrEqual(MAX_COMPARE);
  });

  it("adds a metro, takes it out again, and refuses a fifth", () => {
    expect(toggleCompare([], "10180")).toEqual(["10180"]);
    expect(toggleCompare(["10180", "19100"], "10180")).toEqual(["19100"]);
    const full = ["1", "2", "3", "4"];
    expect(toggleCompare(full, "5")).toBe(full);
    expect(toggleCompare(full, "2")).toEqual(["1", "3", "4"]);
  });
});

describe("the label a line wears", () => {
  it("is the first city named and its state", () => {
    expect(shortLabel("Dallas-Fort Worth-Arlington, TX")).toBe("Dallas, TX");
    expect(shortLabel("Abilene, TX")).toBe("Abilene, TX");
    expect(shortLabel("Hinesville, GA division")).toBe("Hinesville, GA");
    expect(shortLabel("Nowhere")).toBe("Nowhere");
  });
});

describe("labels that would land on top of each other", () => {
  it("are pushed apart without changing their order", () => {
    expect(spreadLabels([50, 52, 54], 12, 0, 200)).toEqual([50, 62, 74]);
    expect(spreadLabels([54, 50, 52], 12, 0, 200)).toEqual([74, 50, 62]);
  });

  it("are left alone when they already clear each other", () => {
    expect(spreadLabels([20, 60, 100], 12, 0, 200)).toEqual([20, 60, 100]);
  });

  it("stay inside the plot when the stack runs past the bottom", () => {
    const out = spreadLabels([190, 192, 194], 12, 10, 200);
    expect(Math.max(...out)).toBeLessThanOrEqual(200);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(10);
    expect(out[0]).toBeLessThan(out[1]);
  });
});

describe("the mark at the end of a line", () => {
  it("draws a closed shape for each of the four kinds, and they differ", () => {
    const paths = MARKERS.map((kind) => markerPath(kind, 10, 20, 4));
    for (const d of paths) expect(d.trim().endsWith("Z")).toBe(true);
    expect(new Set(paths).size).toBe(MARKERS.length);
  });

  it("has a dash and a mark for every slot a comparison can fill", () => {
    expect(DASHES).toHaveLength(MAX_COMPARE);
    expect(MARKERS).toHaveLength(MAX_COMPARE);
    // the first line is the plain one: solid, and a round mark
    expect(DASHES[0]).toBe("");
    expect(new Set(DASHES).size).toBe(MAX_COMPARE);
  });
});

describe("the size the chart is drawn at", () => {
  it("drops the end labels on a phone, where there is no room for a gutter", () => {
    expect(chartSize("phone").labels).toBe(false);
    expect(chartSize("tablet").labels).toBe(true);
    expect(chartSize("wide").labels).toBe(true);
    expect(chartSize("phone").width).toBeLessThan(chartSize("wide").width);
  });

  it("gives the plot the gutter back when no labels are drawn in it", () => {
    const phone = buildCompare([entry("1", "A, TX", series(2000, [100, 110]))], chartSize("phone"));
    expect(phone.right).toBeGreaterThan(chartSize("phone").width - 30);
  });
});

describe("the overlay", () => {
  const two = [
    entry("10180", "Abilene, TX", series(2000, [100, 110, 120, 130])),
    entry("19100", "Dallas-Fort Worth-Arlington, TX", series(2002, [200, 260, 300])),
  ];

  it("puts every series on one pair of axes, spanning all of them", () => {
    const model = buildCompare(two, wide);
    expect(model.years).toEqual([2000, 2004]);
    expect(model.values[0]).toBeLessThanOrEqual(100);
    expect(model.values[1]).toBeGreaterThanOrEqual(300);
    // the same year is the same x on both lines
    const [a, b] = model.lines;
    expect(a.points.find((p) => p.year === 2002)?.x).toBe(b.points.find((p) => p.year === 2002)?.x);
  });

  it("gives each line the next slot, with its own dash and mark", () => {
    const model = buildCompare(two, wide);
    expect(model.lines.map((l) => l.slot)).toEqual([0, 1]);
    expect(model.lines.map((l) => l.dash)).toEqual([DASHES[0], DASHES[1]]);
    expect(model.lines.map((l) => l.marker)).toEqual([MARKERS[0], MARKERS[1]]);
    expect(model.lines.map((l) => l.short)).toEqual(["Abilene, TX", "Dallas, TX"]);
  });

  it("measures growth from the first year every line has, not from its own start", () => {
    const model = buildCompare(two, wide);
    expect(model.shared).toBe(2002);
    // abilene is 120 in 2002 and 130 in 2004, dallas 200 to 300
    expect(model.lines[0].growth).toBeCloseTo((130 / 120 - 1) * 100, 6);
    expect(model.lines[1].growth).toBeCloseTo(50, 6);
  });

  it("has no growth to report when no single year is shared", () => {
    const apart = [
      entry("1", "A, TX", series(2000, [100, 110])),
      entry("2", "B, TX", series(2010, [200, 210])),
    ];
    const model = buildCompare(apart, wide);
    expect(model.shared).toBeNull();
    expect(model.lines.every((l) => l.growth === null)).toBe(true);
  });

  it("breaks a line where a year is missing rather than drawing through it", () => {
    const gap = [entry("1", "A, TX", series(2000, [100, null, 120, 130]))];
    const line = buildCompare(gap, wide).lines[0];
    expect(line.points.map((p) => p.year)).toEqual([2000, 2002, 2003]);
    // one move for the year left on its own, one for the segment after it
    expect(line.d.split("M").length - 1).toBe(2);
    // and the lone year is still drawn, as a segment that goes nowhere
    const x = line.points[0].x;
    expect(line.d).toContain(`M ${x} ${line.points[0].y} L ${x} ${line.points[0].y}`);
  });

  it("pushes end labels apart so four lines that finish together can still be read", () => {
    const close = [1, 2, 3, 4].map((n) => entry(`${n}`, `M${n}, TX`, series(2000, [100, 200 + n])));
    const model = buildCompare(close, wide);
    const ys = model.lines.map((l) => l.labelY).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i += 1) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(12);
  });

  it("takes no more lines than there are slots", () => {
    const five = [1, 2, 3, 4, 5].map((n) => entry(`${n}`, `M${n}, TX`, series(2000, [100, 110])));
    expect(buildCompare(five, wide).lines).toHaveLength(MAX_COMPARE);
  });

  it("holds its ground on nothing to draw", () => {
    expect(buildCompare([], wide).lines).toEqual([]);
    expect(buildCompare([], wide).shared).toBeNull();
    expect(buildCompare([entry("1", "A, TX", series(2000, [null, null]))], wide).lines).toEqual([]);
    const oneYear = buildCompare([entry("1", "A, TX", series(2000, [100]))], wide);
    expect(oneYear.lines[0].last.x).toBeGreaterThan(oneYear.left);
    expect(Number.isFinite(oneYear.lines[0].last.y)).toBe(true);
  });
});

describe("reading the chart at one year", () => {
  const model = buildCompare([
    entry("10180", "Abilene, TX", series(2000, [100, 110, 120])),
    entry("19100", "Dallas-Fort Worth-Arlington, TX", series(2001, [200, 260])),
  ], wide);

  it("has a column for every year on the axis", () => {
    expect(model.columns.map((c) => c.year)).toEqual([2000, 2001, 2002]);
    expect(columnX(model, 2000)).toBe(model.left);
    expect(columnX(model, 1999)).toBeNull();
  });

  it("snaps to the nearest year the pointer is over", () => {
    expect(nearestYear(model, model.left - 50)).toBe(2000);
    expect(nearestYear(model, model.right + 50)).toBe(2002);
    expect(nearestYear(model, (columnX(model, 2001) ?? 0) + 1)).toBe(2001);
  });

  it("reads every line at that year, and says so when one has no value", () => {
    expect(readingAt(model, 2001).map((r) => r.point?.value)).toEqual([110, 200]);
    expect(readingAt(model, 2000).map((r) => r.point?.value ?? null)).toEqual([100, null]);
  });
});

describe("what a screen reader is given instead of the chart", () => {
  it("names every metro with where its line starts and ends", () => {
    const title = compareTitle(buildCompare([
      entry("10180", "Abilene, TX", series(2000, [100, 130])),
      entry("19100", "Dallas-Fort Worth-Arlington, TX", series(2000, [200, 260])),
    ], wide));
    expect(title).toContain("2000 to 2001");
    expect(title).toContain("Abilene, TX");
    expect(title).toContain("Dallas-Fort Worth-Arlington, TX");
    expect(title).toContain("100.0");
    expect(title).toContain("260.0");
  });

  it("says there is nothing to compare rather than an empty sentence", () => {
    expect(compareTitle(buildCompare([], wide))).toBe("no house price history to compare");
  });
});

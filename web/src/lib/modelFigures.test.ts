import { describe, expect, it } from "vitest";
import { FIGURES, FIGURE_FILES, FIGURE_IDS, figureSrc } from "./modelFigures";

const ASCII = /^[\x20-\x7e]*$/;

describe("the figures the model page ships", () => {
  it("names a png the build copies, once each", () => {
    expect(FIGURE_FILES).toHaveLength(FIGURE_IDS.length);
    expect(new Set(FIGURE_FILES).size).toBe(FIGURE_FILES.length);
    for (const file of FIGURE_FILES) expect(file).toMatch(/^\d{2}_[a-z_]+\.png$/);
  });

  it("points at the folder the build copies into, not at the ml folder", () => {
    for (const id of FIGURE_IDS) {
      expect(figureSrc(FIGURES[id])).toBe(`/figures/${FIGURES[id].file}`);
    }
  });

  // alt text that says "chart" tells a reader who cannot see it nothing at
  // all, and these figures are the argument rather than decoration
  it("describes what every figure shows rather than that it is a chart", () => {
    for (const id of FIGURE_IDS) {
      const { alt } = FIGURES[id];
      expect(alt.length, id).toBeGreaterThan(120);
      expect(alt.toLowerCase(), id).not.toMatch(/^(a )?(chart|graph|figure|image|plot)\b/);
      expect(alt.trim(), id).toBe(alt);
    }
  });

  it("gives every figure a caption that says why it is on the page", () => {
    for (const id of FIGURE_IDS) {
      expect(FIGURES[id].caption.length, id).toBeGreaterThan(40);
    }
  });

  // without both, the paragraph under a figure jumps when the png arrives
  it("declares a pixel size for every figure so the column does not reflow", () => {
    for (const id of FIGURE_IDS) {
      const { width, height } = FIGURES[id];
      expect(Number.isInteger(width) && width > 0, id).toBe(true);
      expect(Number.isInteger(height) && height > 0, id).toBe(true);
    }
  });

  it("is ascii, like every other tracked file here", () => {
    for (const id of FIGURE_IDS) {
      const figure = FIGURES[id];
      expect(ASCII.test(figure.alt), `${id} alt`).toBe(true);
      expect(ASCII.test(figure.caption), `${id} caption`).toBe(true);
    }
  });
});

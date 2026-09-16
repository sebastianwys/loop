import { describe, expect, it } from "vitest";
import { DIVERGING, NULL_GRAY, SEQUENTIAL, SURFACE } from "./palette";

// the scale tests pin value to ramp position. nothing pinned the ramp itself,
// so a reversed sequential, swapped diverging arms or a no data gray borrowed
// from a class all stayed green while the map read backwards

const rgb = (hex: string): number[] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

const channel = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a) + 0.05, luminance(b) + 0.05];
  return Math.max(x, y) / Math.min(x, y);
};

const isBlue = (hex: string): boolean => {
  const [r, , b] = rgb(hex);
  return b > r;
};

const isRed = (hex: string): boolean => {
  const [r, , b] = rgb(hex);
  return r > b;
};

describe("sequential ramp", () => {
  it("has five classes", () => {
    expect(SEQUENTIAL).toHaveLength(5);
  });

  it("runs light to dark, so more reads as darker", () => {
    const steps = SEQUENTIAL.map(luminance);
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]).toBeLessThan(steps[i - 1]);
    }
  });

  it("is one hue the whole way", () => {
    expect(SEQUENTIAL.every(isBlue)).toBe(true);
  });

  it("keeps its lightest class off the surface", () => {
    expect(contrast(SURFACE, SEQUENTIAL[0])).toBeGreaterThanOrEqual(1.5);
  });
});

describe("diverging ramp", () => {
  it("has five classes with the neutral in the middle", () => {
    expect(DIVERGING).toHaveLength(5);
    const steps = DIVERGING.map(luminance);
    expect(steps[2]).toBe(Math.max(...steps));
  });

  it("puts blue on the low arm and red on the high arm", () => {
    expect(DIVERGING.slice(0, 2).every(isBlue)).toBe(true);
    expect(DIVERGING.slice(3).every(isRed)).toBe(true);
  });

  it("darkens away from the middle on both arms", () => {
    const steps = DIVERGING.map(luminance);
    expect(steps[0]).toBeLessThan(steps[1]);
    expect(steps[1]).toBeLessThan(steps[2]);
    expect(steps[3]).toBeLessThan(steps[2]);
    expect(steps[4]).toBeLessThan(steps[3]);
  });

  it("mirrors the two arms, so an equal miss either way looks equal", () => {
    const steps = DIVERGING.map(luminance);
    expect(Math.abs(steps[0] - steps[4])).toBeLessThan(0.05);
    expect(Math.abs(steps[1] - steps[3])).toBeLessThan(0.05);
  });
});

describe("no data gray", () => {
  it("is not a class colour in either ramp", () => {
    expect(SEQUENTIAL).not.toContain(NULL_GRAY);
    expect(DIVERGING).not.toContain(NULL_GRAY);
  });

  it("is neutral, so it never reads as a value", () => {
    const [r, g, b] = rgb(NULL_GRAY);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0.1);
  });

  it("is visible on the surface", () => {
    expect(contrast(SURFACE, NULL_GRAY)).toBeGreaterThanOrEqual(1.3);
  });
});

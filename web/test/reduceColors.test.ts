/** Color reduction: merge the most alike colors first, weighted by area. */

import { readFileSync } from "node:fs";
import opencascade from "replicad-opencascadejs";
import { beforeAll, describe, expect, it } from "vitest";
import { build, DEFAULT_OPTIONS } from "../src/engine/build";
import { isValid, setOC, volume } from "../src/engine/occt/kernel";
import { fromOklab, reduceColors, toOklab } from "../src/engine/reduceColors";
import { toHex, type RGB } from "../src/engine/svg/color";

const hex = (colors: readonly RGB[]) => colors.map(toHex);

describe("reduceColors", () => {
  it("round-trips through OKLab", () => {
    for (const rgb of [[0, 0, 0], [1, 1, 1], [0.9, 0.2, 0.4], [0.1, 0.6, 0.3]] as RGB[]) {
      fromOklab(toOklab(rgb)).forEach((v, i) => expect(v).toBeCloseTo(rgb[i], 6));
    }
  });

  it("merges the two colors that look most alike", () => {
    const colors = [
      { color: [1, 0, 0] as RGB, area: 10 },
      { color: [0.95, 0.05, 0.05] as RGB, area: 10 },
      { color: [0, 0, 1] as RGB, area: 10 },
    ];
    const reduced = hex(reduceColors(colors, 2));
    expect(reduced[0]).toBe(reduced[1]);
    expect(reduced[2]).toBe("#0000ff");
  });

  it("judges likeness perceptually, not by RGB distance", () => {
    // Equal steps in sRGB, but the step between the darks looks far bigger.
    const colors = [0, 0.2, 0.8, 1].map((v) => ({ color: [v, v, v] as RGB, area: 1 }));
    const reduced = hex(reduceColors(colors, 3));
    expect(reduced[2]).toBe(reduced[3]);
    expect(reduced[0]).not.toBe(reduced[1]);
  });

  it("weights a merged color by area", () => {
    const reduced = reduceColors([{ color: [1, 1, 1], area: 99 }, { color: [0.9, 0.9, 1], area: 1 }], 1);
    const [r, g, b] = reduced[0];
    expect(r).toBeGreaterThan(0.99);
    expect(b).toBeCloseTo(1, 3);
    expect(g).toBeCloseTo(r, 4);
  });

  it("leaves colors alone when there are no more than the target", () => {
    const colors = [{ color: [0.2, 0.3, 0.4] as RGB, area: 5 }, { color: [0.6, 0.1, 0.9] as RGB, area: 0 }];
    expect(reduceColors(colors, 2)).toEqual(colors.map((c) => c.color));
  });
});

describe("build with a color limit", () => {
  const svg = readFileSync(new URL("../../examples/test.svg", import.meta.url), "utf8");

  beforeAll(async () => {
    setOC(await opencascade({ print: () => {}, printErr: () => {} }));
  });

  it("keeps the requested number of colors and the same total volume", () => {
    const full = build(svg, DEFAULT_OPTIONS);
    const total = (model: typeof full) => model.parts.reduce((sum, p) => sum + volume(p.solid), 0);
    for (let count = full.svgColors - 1; count >= 2; count--) {
      const reduced = build(svg, { ...DEFAULT_OPTIONS, maxColors: count });
      expect(reduced.svgColors).toBe(full.svgColors);
      expect(reduced.palette).toHaveLength(count);
      expect(total(reduced)).toBeCloseTo(total(full), 3);
      for (const part of reduced.parts) expect(isValid(part.solid), part.label).toBe(true);
    }
  });
});

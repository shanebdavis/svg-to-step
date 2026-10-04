/** Fill rules follow SVG semantics, checked against a sampled winding number. */

import opencascade from "replicad-opencascadejs";
import { beforeAll, describe, expect, it } from "vitest";
import { build, DEFAULT_OPTIONS } from "../src/engine/build";
import { isValid, setOC, volume } from "../src/engine/occt/kernel";
import { toHex } from "../src/engine/svg/color";
import { windingNumber, type Point } from "../src/engine/svg/geometry";

beforeAll(async () => {
  setOC(await opencascade({ print: () => {}, printErr: () => {} }));
});

const STAR: Point[] = [[50, 5], [76, 90], [5, 35], [95, 35], [24, 90]];
const HEIGHT = 2;

/** Area the rule fills, by sampling winding numbers on a fine grid (viewBox units). */
function sampledArea(polygons: Point[][], rule: "nonzero" | "evenodd", step = 0.1): number {
  let count = 0;
  for (let x = step / 2; x < 100; x += step) {
    for (let y = step / 2; y < 100; y += step) {
      const w = windingNumber([x, y], polygons);
      if (rule === "evenodd" ? w % 2 !== 0 : w !== 0) count++;
    }
  }
  return count * step * step;
}

function piecesByColor(svg: string) {
  const model = build(svg, { ...DEFAULT_OPTIONS, size: 100, height: HEIGHT, slabColor: null });
  expect(model.parts.every((p) => isValid(p.solid))).toBe(true);
  const byColor = new Map<string, number[]>();
  for (const p of model.parts) byColor.set(toHex(p.color), [...(byColor.get(toHex(p.color)) ?? []), volume(p.solid) / HEIGHT]);
  return byColor;
}

const doc = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
const points = STAR.map((p) => p.join(" ")).join(" L ");

describe("self-intersecting paths", () => {
  it("nonzero fills the star's center", () => {
    const pieces = piecesByColor(doc(`<path fill="#f00" d="M ${points} Z"/>`));
    expect(pieces.get("#ff0000")).toHaveLength(1);
    expect(pieces.get("#ff0000")![0]).toBeCloseTo(sampledArea([STAR], "nonzero"), -1);
  });

  it("evenodd leaves the center empty, giving five points", () => {
    const pieces = piecesByColor(doc(`<path fill="#00f" fill-rule="evenodd" d="M ${points} Z"/>`));
    expect(pieces.get("#0000ff")).toHaveLength(5);
    const total = pieces.get("#0000ff")!.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(sampledArea([STAR], "evenodd"), -1);
  });
});

describe("nested contours", () => {
  const square = (x: number, size: number, clockwise: boolean) =>
    clockwise ? `M${x} ${x}h${size}v${size}h-${size}Z` : `M${x} ${x}v${size}h${size}v-${size}Z`;

  it("nonzero keeps a same-direction inner contour filled", () => {
    const pieces = piecesByColor(doc(`<path fill="#0f0" d="${square(10, 80, true)} ${square(30, 40, true)}"/>`));
    const total = pieces.get("#00ff00")!.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(80 * 80, 1);
  });

  it("nonzero cuts a hole for an opposite-direction inner contour", () => {
    const pieces = piecesByColor(doc(`<path fill="#0f0" d="${square(10, 80, true)} ${square(30, 40, false)}"/>`));
    expect(pieces.get("#00ff00")!.reduce((a, b) => a + b, 0)).toBeCloseTo(80 * 80 - 40 * 40, 1);
  });

  it("evenodd always cuts a hole", () => {
    const pieces = piecesByColor(doc(`<path fill="#0f0" fill-rule="evenodd" d="${square(10, 80, true)} ${square(30, 40, true)}"/>`));
    expect(pieces.get("#00ff00")!.reduce((a, b) => a + b, 0)).toBeCloseTo(80 * 80 - 40 * 40, 1);
  });

  it("overlapping subpaths merge under nonzero", () => {
    const pieces = piecesByColor(doc(`<path fill="#0f0" d="M10 10h50v50h-50Z M40 40h50v50h-50Z"/>`));
    expect(pieces.get("#00ff00")).toHaveLength(1);
    expect(pieces.get("#00ff00")![0]).toBeCloseTo(2 * 2500 - 400, 1);
  });
});

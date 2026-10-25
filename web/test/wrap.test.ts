/** Wrapped slabs: the smallest shape around the art, then a puzzle that fills it exactly. */

import { readFileSync } from "node:fs";
import opencascade from "replicad-opencascadejs";
import { beforeAll, describe, expect, it } from "vitest";
import { build, DEFAULT_OPTIONS } from "../src/engine/build";
import { area, boundingBox, faceFromWires, isValid, setOC, volume, wireFromContour } from "../src/engine/occt/kernel";
import type { Point } from "../src/engine/svg/geometry";
import { enclosingCircle, enclosingHexagon, wrapContour } from "../src/engine/wrap";

const square: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10], [3, 4]];

describe("enclosing shapes", () => {
  it("circle passes through the farthest points", () => {
    const { center, radius } = enclosingCircle(square);
    expect(center[0]).toBeCloseTo(5);
    expect(center[1]).toBeCloseTo(5);
    expect(radius).toBeCloseTo(Math.hypot(5, 5));
  });

  it("circle of a triangle is its circumcircle when acute, its diameter when obtuse", () => {
    expect(enclosingCircle([[0, 0], [2, 0], [1, Math.sqrt(3)]]).radius).toBeCloseTo(2 / Math.sqrt(3));
    expect(enclosingCircle([[0, 0], [10, 0], [5, 1]]).radius).toBeCloseTo(5);
  });

  it("hexagon is tight against its own corners", () => {
    const corners = Array.from({ length: 6 }, (_, i): Point => [7 + 4 * Math.cos((i * Math.PI) / 3), -2 + 4 * Math.sin((i * Math.PI) / 3)]);
    const { center, apothem } = enclosingHexagon(corners);
    expect(center[0]).toBeCloseTo(7);
    expect(center[1]).toBeCloseTo(-2);
    expect(apothem).toBeCloseTo(2 * Math.sqrt(3));
  });

  it("hexagon covers every point and is no bigger than needed", () => {
    const points: Point[] = Array.from({ length: 200 }, (_, i) => [Math.sin(i * 12.9898) * 40, Math.cos(i * 78.233) * 15 + 3]);
    const { center, apothem } = enclosingHexagon(points);
    const s = Math.sqrt(3) / 2;
    const reach = (n: Point) => Math.max(...points.map(([x, y]) => Math.abs(n[0] * (x - center[0]) + n[1] * (y - center[1]))));
    const reaches = [[0, 1], [s, 0.5], [-s, 0.5]].map((n) => reach(n as unknown as Point));
    for (const r of reaches) expect(r).toBeLessThanOrEqual(apothem + 1e-9);
    expect(Math.max(...reaches)).toBeCloseTo(apothem);
  });

  it("square is centered on the bounding box and padded on every side", () => {
    const contour = wrapContour([[0, 0], [20, 4]], "square", 2);
    expect(contour.kind === "path" && contour.segments.map((s) => s.from)).toEqual([[-2, -10], [22, -10], [22, 14], [-2, 14]]);
  });
});

describe("puzzle with a wrapped slab", () => {
  const svg = readFileSync(new URL("../../examples/test.svg", import.meta.url), "utf8");

  beforeAll(async () => {
    setOC(await opencascade({ print: () => {}, printErr: () => {} }));
  });

  it.each(["square", "circle", "hexagon"] as const)("%s: fits size exactly, with the art padded inside", (slabShape) => {
    const model = build(svg, { ...DEFAULT_OPTIONS, slabShape, slabPadding: 3 });
    for (const part of model.parts) expect(isValid(part.solid), part.label).toBe(true);
    const span = (parts: typeof model.parts) => {
      const boxes = parts.map((p) => boundingBox(p.solid));
      return {
        minX: Math.min(...boxes.map((b) => b.minX)), maxX: Math.max(...boxes.map((b) => b.maxX)),
        minY: Math.min(...boxes.map((b) => b.minY)), maxY: Math.max(...boxes.map((b) => b.maxY)),
      };
    };
    const slab = span(model.parts);
    const art = span(model.parts.filter((p) => !p.label.startsWith("background")));
    const [width, height] = [slab.maxX - slab.minX, slab.maxY - slab.minY];
    expect(Math.max(width, height)).toBeCloseTo(DEFAULT_OPTIONS.size, 6);
    expect(Math.min(width, height)).toBeLessThanOrEqual(DEFAULT_OPTIONS.size + 1e-6);
    // Padding stays true millimeters: only the art scales to fit.
    expect(art.minX - slab.minX).toBeGreaterThan(2.9);
    expect(slab.maxX - art.maxX).toBeGreaterThan(2.9);
    expect(art.minY - slab.minY).toBeGreaterThan(2.9);
    expect(slab.maxY - art.maxY).toBeGreaterThan(2.9);
  });

  it("fits the art itself to size without a slab", () => {
    const model = build(svg, { ...DEFAULT_OPTIONS, slabColor: null });
    const boxes = model.parts.map((p) => boundingBox(p.solid));
    const width = Math.max(...boxes.map((b) => b.maxX)) - Math.min(...boxes.map((b) => b.minX));
    const height = Math.max(...boxes.map((b) => b.maxY)) - Math.min(...boxes.map((b) => b.minY));
    expect(Math.max(width, height)).toBeCloseTo(DEFAULT_OPTIONS.size, 6);
  });

  it("circle slab volume is the padded enclosing circle times the height", () => {
    const model = build(svg, { ...DEFAULT_OPTIONS, slabShape: "circle", slabPadding: 3 });
    const total = model.parts.reduce((sum, p) => sum + volume(p.solid), 0);
    const boxes = model.parts.map((p) => boundingBox(p.solid));
    const radius = (Math.max(...boxes.map((b) => b.maxX)) - Math.min(...boxes.map((b) => b.minX))) / 2;
    const disk = area(faceFromWires(wireFromContour({ kind: "circle", center: [0, 0], radius }), []));
    expect(total).toBeCloseTo(disk * DEFAULT_OPTIONS.height, 0);
  });
});

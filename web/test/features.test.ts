/** Minimum feature size and brush edits: thin parts merge, thicken or stay; delete strokes drop whole shapes. */

import { areaPathsD, differenceD, FillRule, intersectD } from "clipper2-ts";
import opencascade from "replicad-opencascadejs";
import { beforeAll, describe, expect, it } from "vitest";
import { build, DEFAULT_OPTIONS, type BuildOptions, type Model } from "../src/engine/build";
import { coveredBy, paintMasks, sweep, thinParts, toPaths, type Stroke } from "../src/engine/features";
import { isValid, setOC, volume } from "../src/engine/occt/kernel";
import { toHex } from "../src/engine/svg/color";
import type { Point } from "../src/engine/svg/geometry";

const rect = (x: number, y: number, w: number, h: number): Point[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const area = (paths: ReturnType<typeof toPaths>) => Math.abs(areaPathsD(paths));

const minus = (a: ReturnType<typeof toPaths>, b: ReturnType<typeof toPaths>) => differenceD(a, b, FillRule.NonZero, 4);
const both = (a: ReturnType<typeof toPaths>, b: ReturnType<typeof toPaths>) => intersectD(a, b, FillRule.NonZero, 4);

/** A band of the given width along an arc of radius r from angle a to b. */
function arcBand(r: number, width: number, a: number, b: number): Point[] {
  const n = 120;
  const at = (radius: number, t: number): Point => [radius * Math.cos(t), radius * Math.sin(t)];
  const outer = Array.from({ length: n + 1 }, (_, i) => at(r + width / 2, a + ((b - a) * i) / n));
  const inner = Array.from({ length: n + 1 }, (_, i) => at(r - width / 2, b - ((b - a) * i) / n));
  return [...outer, ...inner];
}

describe("thin parts", () => {
  it("leaves a plain square alone, corners included", () => {
    expect(thinParts(toPaths([rect(0, 0, 10, 10)]), 0.5)).toEqual([]);
  });

  it("finds a thin neck between two blobs", () => {
    const dumbbell: Point[] = [[0, 0], [5, 0], [5, 2.4], [10, 2.4], [10, 0], [15, 0], [15, 5], [10, 5], [10, 2.7], [5, 2.7], [5, 5], [0, 5]];
    const region = toPaths([dumbbell]);
    const parts = thinParts(region, 0.5);
    expect(parts).toHaveLength(1);
    // The neck goes, plus a little of the corners where it meets each blob.
    const removed = area(both(region, sweep(parts[0].lines, 0.5)));
    expect(removed).toBeGreaterThan(5 * 0.3 - 0.01);
    expect(removed).toBeLessThan(5 * 0.3 * 1.2);
  });

  it("follows a thin ring all the way round", () => {
    const ring = toPaths([rect(0, 0, 10, 10), rect(0.2, 0.2, 9.6, 9.6).reverse()]);
    const parts = thinParts(ring, 0.5);
    expect(parts).toHaveLength(1);
    expect(area(minus(ring, sweep(parts[0].lines, 0.5)))).toBeLessThan(0.01);
  });

  it("thickens a curved hairline into an even band", () => {
    const band = toPaths([arcBand(10, 0.15, 0, 2)]);
    const parts = thinParts(band, 1);
    expect(parts).toHaveLength(1);
    const grown = sweep(parts[0].joined, 1);
    // Close to the ideal: the arc's own center line swept by a 1 mm disc, with no lumps outside a 10% wider sweep.
    const ideal = Array.from({ length: 200 }, (_, i): Point => [10 * Math.cos((2 * i) / 199), 10 * Math.sin((2 * i) / 199)]);
    expect(area(minus(grown, sweep([ideal], 1.1)))).toBeLessThan(0.01);
    // Each end stops about half the original width short of its tip.
    const trimmed = Array.from({ length: 200 }, (_, i): Point => {
      const t = 0.015 + ((2 - 0.03) * i) / 199;
      return [10 * Math.cos(t), 10 * Math.sin(t)];
    });
    expect(area(minus(sweep([trimmed], 0.9), grown))).toBeLessThan(0.01);
  });

  it("retreats an acute spike to where it is wide enough, keeping the square's corners", () => {
    const spiked: Point[] = [[0, 0], [10, 0], [10, 4], [20, 5], [10, 6], [10, 10], [0, 10]];
    const region = toPaths([spiked]);
    const parts = thinParts(region, 1);
    expect(parts).toHaveLength(1);
    const kept = minus(region, sweep(parts[0].lines, 1));
    expect(thinParts(kept, 1)).toEqual([]);
    for (const corner of [[0, 0], [10, 0], [10, 10], [0, 10]] as Point[]) {
      expect(area(both(kept, toPaths([rect(corner[0] - 0.05, corner[1] - 0.05, 0.1, 0.1)])))).toBeCloseTo(0.0025, 4);
    }
  });
});

describe("paint", () => {
  const stroke = (mode: Stroke["mode"], points: Point[], radius = 1): Stroke => ({ mode, radius, points });

  it("gives overlapping paint to the later stroke", () => {
    const masks = paintMasks([stroke("merge", [[0, 0], [10, 0]]), stroke("thicken", [[5, 0]])]);
    expect(area(masks.thicken)).toBeCloseTo(Math.PI, 1);
    // The circle sits inside the capsule, so the capsule loses exactly the circle.
    expect(area(masks.merge)).toBeCloseTo(10 * 2, 0);
  });

  it("erases paint of every kind", () => {
    const masks = paintMasks([stroke("delete", [[0, 0]]), stroke("keep", [[0, 0]]), stroke("erase", [[0, 0]], 2)]);
    expect(area(masks.delete) + area(masks.keep)).toBe(0);
  });

  it("covers a shape only entirely", () => {
    const mask = paintMasks([stroke("delete", [[0, 0], [10, 0]], 2)]).delete;
    expect(coveredBy(toPaths([rect(1, -1, 3, 2)]), mask)).toBe(true);
    expect(coveredBy(toPaths([rect(1, -1, 3, 5)]), mask)).toBe(false);
  });
});

describe("build", () => {
  // A blue square with a 0.2 mm red line across it and out over the slab, in a 100 mm canvas.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect x="20" y="20" width="60" height="60" fill="#0000ff"/>
    <rect x="10" y="49.9" width="80" height="0.2" fill="#ff0000"/>
  </svg>`;
  const total = (model: Model) => model.parts.reduce((sum, p) => sum + volume(p.solid), 0);
  const colorVolume = (model: Model, hex: string) =>
    model.parts.filter((p) => toHex(p.color) === hex).reduce((sum, p) => sum + volume(p.solid), 0);
  const run = (options: Partial<BuildOptions>) => {
    const model = build(svg, { ...DEFAULT_OPTIONS, minArea: 0.01, ...options });
    for (const part of model.parts) expect(isValid(part.solid), part.label).toBe(true);
    return model;
  };

  beforeAll(async () => {
    setOC(await opencascade({ print: () => {}, printErr: () => {} }));
  });

  it("merges a too-thin line into its neighbors", () => {
    const model = run({ minFeature: 0.5, featureMode: "merge" });
    expect(colorVolume(model, "#ff0000")).toBe(0);
    expect(total(model)).toBeCloseTo(100 * 100 * 5, 0);
    expect(model.changes.filter((c) => c.mode === "merge").length).toBeGreaterThan(0);
  });

  it("thickens a too-thin line to the minimum width", () => {
    const model = run({ minFeature: 0.5, featureMode: "thicken" });
    const red = colorVolume(model, "#ff0000") / 5;
    expect(red).toBeGreaterThan(80 * 0.5 - 0.01);
    expect(red).toBeLessThan(80 * 0.7);
    expect(total(model)).toBeCloseTo(100 * 100 * 5, 0);
  });

  it("keeps the line where a keep brush covers it", () => {
    const keep: Stroke = { mode: "keep", radius: 2, points: [[5, 50], [95, 50]] };
    const model = run({ minFeature: 0.5, featureMode: "merge", strokes: [keep] });
    expect(colorVolume(model, "#ff0000")).toBeCloseTo(80 * 0.2 * 5, 1);
  });

  it("deletes shapes a delete stroke fully covers, and shapes picked by index", () => {
    const erase: Stroke = { mode: "delete", radius: 1, points: [[5, 50], [95, 50]] };
    const brushed = run({ strokes: [erase] });
    expect(brushed.deleted).toEqual([1]);
    expect(colorVolume(brushed, "#ff0000")).toBe(0);
    const picked = run({ deletedShapes: [0] });
    expect(picked.deleted).toEqual([0]);
    expect(colorVolume(picked, "#0000ff")).toBe(0);
  });
});

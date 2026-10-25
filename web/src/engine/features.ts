/**
 * Minimum feature size: find the parts of each color region too thin to
 * print, and plan what happens to each one. Painted brush strokes choose the
 * action per area; elsewhere a default applies.
 *
 * Thin parts are found on the region's center line (see centerline.ts).
 * Thickening sweeps a disc of the minimum width along that line, giving even
 * strokes; merging hands the region under that sweep to a neighbor, so a thin
 * part retreats to where the region is wide enough.
 *
 * Pure polygon math (Clipper2), in model millimeters, Y up.
 */

import {
  areaPathsD, booleanOpDWithPolyTree, ClipType, differenceD, EndType, FillRule, inflatePathsD, intersectD, JoinType,
  PolyTreeD, unionD, type PathD, type PathsD, type PolyPathD,
} from "clipper2-ts";
import { chordalAxis, polylines, smooth } from "./centerline";
import type { Point } from "./svg/geometry";

/** What happens to a too-thin part. */
export type FeatureMode = "keep" | "merge" | "thicken";
/** "delete" removes whole SVG shapes it fully covers; "erase" clears paint. */
export type BrushMode = FeatureMode | "delete" | "erase";

export interface Stroke { mode: BrushMode; radius: number; points: Point[] }

export type Masks = Record<Exclude<BrushMode, "erase">, PathsD>;

const PRECISION = 4;
const MITER_LIMIT = 10;
const NONZERO = FillRule.NonZero;

export const toPaths = (polygons: readonly (readonly Point[])[]): PathsD => polygons.map((p) => p.map(([x, y]) => ({ x, y })));
export const fromPaths = (paths: PathsD): Point[][] => paths.map((p) => p.map(({ x, y }): Point => [x, y]));

const grow = (paths: PathsD, delta: number, join = JoinType.Round) =>
  inflatePathsD(paths, delta, join, EndType.Polygon, MITER_LIMIT, PRECISION, Math.max(Math.abs(delta) / 20, 1e-3));
const union = (a: PathsD, b: PathsD = []) => unionD(a, b, NONZERO, PRECISION);
const minus = (a: PathsD, b: PathsD) => differenceD(a, b, NONZERO, PRECISION);
const both = (a: PathsD, b: PathsD) => intersectD(a, b, NONZERO, PRECISION);
const area = (paths: PathsD) => Math.abs(areaPathsD(paths));

/** The disc-swept area of a stroke. */
export function strokeArea({ points, radius }: Stroke): PathsD {
  return inflatePathsD([toPaths([points])[0]], radius, JoinType.Round, EndType.Round, MITER_LIMIT, PRECISION, radius / 100);
}

/** Painted area per brush. A later stroke takes its area from every other brush. */
export function paintMasks(strokes: Stroke[]): Masks {
  const masks: Masks = { delete: [], keep: [], merge: [], thicken: [] };
  for (const stroke of strokes) {
    const swept = strokeArea(stroke);
    for (const mode of Object.keys(masks) as (keyof Masks)[]) {
      masks[mode] = mode === stroke.mode ? union(masks[mode], swept) : minus(masks[mode], swept);
    }
  }
  return masks;
}

/** True when the mask covers the polygons entirely. */
export function coveredBy(polygons: PathsD, mask: PathsD): boolean {
  const whole = area(union(polygons));
  return whole > 0 && area(minus(polygons, mask)) <= whole * 1e-6;
}

/** Each connected piece of an area: an outline with its holes. */
function pieces(paths: PathsD): PathsD[] {
  const tree = new PolyTreeD();
  booleanOpDWithPolyTree(ClipType.Union, paths, null, tree, NONZERO, PRECISION);
  const result: PathsD[] = [];
  const visit = (node: PolyPathD) => {
    for (let i = 0; i < node.count; i++) {
      const outer = node.child(i);
      const holes: PathD[] = [];
      for (let j = 0; j < outer.count; j++) {
        holes.push(outer.child(j).poly!);
        visit(outer.child(j));
      }
      result.push([outer.poly!, ...holes]);
    }
  };
  visit(tree);
  return result;
}

export interface ThinPart {
  /** Center lines through the too-thin part. */
  lines: Point[][];
  /** The same, carried one step into the wide parts it joins, so thickening blends in. */
  joined: Point[][];
}

/**
 * The too-thin parts of a region, found on its center line: connected runs of
 * axis points where the region is narrower than width. A short run that ends
 * at a tip and joins a wide part on one side only is a corner, not a feature.
 */
export function thinParts(region: PathsD, width: number): ThinPart[] {
  const axis = chordalAxis(region, width / 6);
  const thin = (i: number) => !axis.pruned.has(i) && !axis.corners.has(i) && axis.widths[i] < width;
  const seen = new Set<number>();
  const parts: ThinPart[] = [];
  for (let start = 0; start < axis.points.length; start++) {
    if (seen.has(start) || !thin(start)) continue;
    const run = new Set([start]);
    const joins = new Set<number>();
    let length = 0;
    for (const queue = [start]; queue.length;) {
      const i = queue.pop()!;
      for (const n of axis.links[i]) {
        if (axis.corners.has(n)) continue;
        if (!thin(n)) joins.add(n);
        else {
          if (i < n) length += Math.hypot(axis.points[i][0] - axis.points[n][0], axis.points[i][1] - axis.points[n][1]);
          if (!run.has(n)) {
            run.add(n);
            queue.push(n);
          }
        }
      }
    }
    run.forEach((i) => seen.add(i));
    // A run needs a chord that measured it thin; junctions between corner chords measure nothing.
    if (![...run].some((i) => axis.chords.has(i))) continue;
    if (joins.size === 1 && length < 1.5 * width) continue;
    smooth(axis, run);
    parts.push({ lines: polylines(axis, run), joined: polylines(axis, new Set([...run, ...joins])) });
  }
  return parts;
}

/** A disc of diameter width swept along the lines. */
export const sweep = (lines: Point[][], width: number) =>
  inflatePathsD(toPaths(lines), width / 2, JoinType.Round, EndType.Round, MITER_LIMIT, PRECISION, width / 100);

export interface FeaturePlan {
  /** Areas each color takes from every other, in the order they apply; null color means removed. */
  claims: { key: string | null; paths: PathsD }[];
  /** What changed, for previews. */
  changes: { mode: "merge" | "thicken"; paths: PathsD }[];
}

/**
 * Plan the fix for every too-thin part. A part follows the brush covering most
 * of it, else fallback. Thickened parts take room from their neighbors, but
 * never grow past bounds (the slab) when given; smaller colors win where two
 * collide, and thickening wins over merging.
 *
 * Merged parts go to the neighboring color sharing the most border with what
 * that color keeps. Merging can strand small pieces, like the spot where two
 * strokes of a letter meet; those merge too. A part with no kept neighbor,
 * such as a letter's thin counter inside thin strokes, follows the merging
 * part it borders most, and stays put if that leads back to its own color.
 */
export function planFeatures(
  regions: Map<string, PathsD>, width: number, fallback: FeatureMode, masks: Masks, bounds: PathsD | null,
): FeaturePlan {
  const touch = width * 0.05;
  const shared = (piece: PathsD, paths: PathsD) => area(both(grow(piece, touch), paths));
  const thickens: (FeaturePlan["claims"][number] & { area: number })[] = [];
  const changes: FeaturePlan["changes"] = [];
  const merges: { key: string; piece: PathsD; to?: string | null }[] = [];

  for (const [key, region] of regions) {
    const own: PathsD[] = [];
    for (const part of thinParts(region, width)) {
      const fragment = both(region, sweep(part.lines, width));
      const size = area(fragment);
      if (size === 0) continue;
      const brushes = (["keep", "merge", "thicken"] as const).map((mode) => ({ mode, share: area(both(fragment, masks[mode])) / size }));
      const brush = brushes.reduce((a, b) => (b.share > a.share ? b : a));
      const mode = brush.share > 0.5 ? brush.mode : fallback;
      if (mode === "merge") own.push(fragment);
      else if (mode === "thicken") {
        const grown = union(sweep(part.joined, width), fragment);
        const claim = bounds ? both(grown, bounds) : grown;
        thickens.push({ key, paths: claim, area: area(region) });
        changes.push({ mode, paths: minus(claim, fragment) });
      }
    }
    if (!own.length) continue;
    const removed = union(own.flat());
    // Crumbs along the cut are numeric noise; the sliver pass after this absorbs them.
    const stranded = pieces(minus(region, removed)).filter((piece) => {
      const size = area(piece);
      return size > touch * touch && size < Math.PI * width * width && shared(piece, removed) > 0;
    });
    for (const piece of [...own, ...stranded]) merges.push({ key, piece });
  }

  const kept = new Map([...regions].map(([key, region]) => [
    key, minus(region, union(merges.filter((m) => m.key === key).flatMap((m) => m.piece))),
  ]));
  for (const merge of merges) {
    let best = { key: null as string | null, shared: 0 };
    for (const [other, paths] of kept) {
      if (other === merge.key) continue;
      const amount = shared(merge.piece, paths);
      if (amount > best.shared) best = { key: other, shared: amount };
    }
    if (best.key !== null) merge.to = best.key;
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const merge of merges) {
      if (merge.to !== undefined) continue;
      let best = { to: undefined as string | null | undefined, shared: 0 };
      for (const other of merges) {
        if (other === merge || other.to === undefined) continue;
        const amount = shared(merge.piece, other.piece);
        if (amount > best.shared) best = { to: other.to, shared: amount };
      }
      if (best.to !== undefined) {
        merge.to = best.to;
        changed = true;
      }
    }
  }

  const claims: FeaturePlan["claims"] = [];
  for (const merge of merges) {
    if (merge.to === merge.key) continue;
    // No neighbor at all (no slab): the part is removed. Slightly oversized, so
    // curved edges flattened to polygons leave no gaps.
    claims.push({ key: merge.to ?? null, paths: grow(merge.piece, touch / 2) });
    changes.push({ mode: "merge", paths: merge.piece });
  }
  thickens.sort((a, b) => b.area - a.area);
  const ordered = [...claims, ...thickens.map(({ key, paths }) => ({ key, paths }))];
  // Later claims win: each keeps only what no later claim by another color takes.
  return {
    claims: ordered.map((claim, i) => {
      const later = union(ordered.slice(i + 1).filter((c) => c.key !== claim.key).flatMap((c) => c.paths));
      return { key: claim.key, paths: minus(claim.paths, later) };
    }).filter((claim) => area(claim.paths) > 0),
    changes,
  };
}

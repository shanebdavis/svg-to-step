/**
 * SVG to colored solids. Mirrors svg2step.py:
 *
 * Puzzle mode: the canvas becomes a slab with every painted shape cut out of
 * it, and each visible connected single-color region is a solid filling its
 * cutout exactly.
 *
 * Layers mode: one layer per color, stacked by area. Each layer covers its own
 * color plus every color above it, so each color shows from the top at its
 * own step height.
 *
 * Either way, overlaps resolve by paint order, so the top view matches the SVG.
 */

import type { TopoDS_Face, TopoDS_Shape, TopoDS_Solid } from "replicad-opencascadejs";
import { toHex, type RGB } from "./svg/color";
import { parseSvg } from "./svg/parseSvg";
import type { Point } from "./svg/geometry";
import {
  area, boundingBox, common, cut, distanceToPoint, edgeLength, edgeSamples, edgesOf, extrude,
  facesFromContours, facesOf, fuse, rectangleFace, repairFace, unifyFaces, type Box,
} from "./occt/kernel";

export interface BuildOptions {
  /** Longest side of the canvas, mm. */
  size: number;
  /** Total height, mm. */
  height: number;
  /** Slab color, or null for no slab. */
  slabColor: RGB | null;
  mode: "puzzle" | "layers";
  /** Layers mode: which colors sit lowest. */
  order: "large" | "small";
  /** Layers mode: fixed thickness, or null to split the height evenly. */
  layerThickness: number | null;
  /** Regions under this area (mm²) merge into a neighbor. */
  minArea: number;
}

export const DEFAULT_OPTIONS: BuildOptions = {
  size: 150, height: 5, slabColor: [128 / 255, 128 / 255, 128 / 255],
  mode: "puzzle", order: "large", layerThickness: null, minArea: 0.5,
};

export interface Part {
  solid: TopoDS_Solid;
  label: string;
  color: RGB;
  /** Stacking level, 0 = bottom; drives exploded previews. */
  level: number;
}

export interface Model {
  parts: Part[];
  colors: number;
  width: number;
  height: number;
}

const BACKGROUND = "background";
type Key = string; // hex color or BACKGROUND

/** Visible part of each color, top-down so higher shapes win overlaps. */
function visibleRegions(painted: { face: TopoDS_Face; key: Key }[], canvas: TopoDS_Face) {
  const byColor = new Map<Key, TopoDS_Face[]>();
  let covered: TopoDS_Shape | null = null;
  for (const { face, key } of [...painted].reverse()) {
    const parts = covered ? facesOf(cut(face, covered)) : [face];
    for (const part of parts) {
      const visible = facesOf(common(part, canvas));
      if (visible.length) byColor.set(key, [...(byColor.get(key) ?? []), ...visible]);
    }
    covered = covered ? fuse([covered, face]) : face;
  }
  return { byColor, covered };
}

/** Fuse same-color fragments, then split into connected regions. */
function mergeTouching(faces: TopoDS_Face[]): TopoDS_Face[] {
  return faces.length === 1 ? faces : facesOf(unifyFaces(fuse(faces)));
}

function overlaps(a: Box, b: Box, tolerance: number): boolean {
  return !(b.minX > a.maxX + tolerance || b.maxX < a.minX - tolerance ||
    b.minY > a.maxY + tolerance || b.maxY < a.minY - tolerance);
}

interface Piece { key: Key; face: TopoDS_Face; box: Box; area: number }

const piece = (key: Key, face: TopoDS_Face): Piece => ({ key, face, box: boundingBox(face), area: area(face) });

/** Index of the piece sharing the most border with sliver, or null. */
function bestNeighbor(sliver: Piece, pieces: Piece[], tolerance: number): number | null {
  const candidates = pieces.flatMap((p, i) => (overlaps(sliver.box, p.box, tolerance) ? [i] : []));
  if (!candidates.length) return null;
  const shared = new Map<number, number>();
  const samples = 8;
  for (const edge of edgesOf(sliver.face)) {
    const length = edgeLength(edge);
    for (const point of edgeSamples(edge, samples)) {
      let best = { distance: Infinity, i: -1 };
      for (const i of candidates) {
        const distance = distanceToPoint(pieces[i].face, point as Point);
        if (distance < best.distance) best = { distance, i };
      }
      if (best.distance < tolerance) shared.set(best.i, (shared.get(best.i) ?? 0) + length / samples);
    }
  }
  if (!shared.size) return null;
  return [...shared.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

/**
 * Merge regions smaller than minArea into the neighbor sharing the most border.
 * Slivers come from nearly coincident edges in the artwork: too small to print,
 * and as tiny holes in a larger face they break display meshing.
 */
function absorbSlivers(regions: Map<Key, TopoDS_Face[]>, minArea: number, tolerance: number) {
  const pieces = [...regions].flatMap(([key, faces]) => faces.map((face) => piece(key, face)));
  const keep = pieces.filter((p) => p.area >= minArea);
  const slivers = pieces.filter((p) => p.area < minArea).sort((a, b) => a.area - b.area);
  for (const sliver of slivers) {
    const i = bestNeighbor(sliver, keep, tolerance);
    if (i !== null) {
      const { key, face } = keep[i];
      keep.splice(i, 1, ...mergeTouching([face, sliver.face]).map((f) => piece(key, f)));
    }
  }
  const merged = new Map<Key, TopoDS_Face[]>();
  for (const { key, face } of keep) merged.set(key, [...(merged.get(key) ?? []), face]);
  return merged;
}

/**
 * Bottom-up thickness of each layer. Auto (null) splits height evenly. A fixed
 * thickness that needs more than height raises the total; one that needs less
 * gives the rest to the bottom layer.
 */
export function layerThicknesses(count: number, height: number, layerThickness: number | null): number[] {
  if (layerThickness === null) return Array(count).fill(height / count);
  const bottom = Math.max(layerThickness, height - layerThickness * (count - 1));
  return [bottom, ...Array(count - 1).fill(layerThickness)];
}

export function build(svgText: string, options: BuildOptions): Model {
  const svg = parseSvg(svgText, options.size);
  const colorOf = new Map<Key, RGB>();
  const painted = svg.shapes.flatMap((shape) => {
    const key = toHex(shape.color);
    colorOf.set(key, shape.color);
    return facesFromContours(shape.contours, shape.fillRule).flatMap(repairFace).map((face) => ({ face, key }));
  });
  const canvas = rectangleFace(svg.width, svg.height);

  const { byColor, covered } = visibleRegions(painted, canvas);
  let regions = new Map<Key, TopoDS_Face[]>();
  for (const [key, faces] of byColor) regions.set(key, mergeTouching(faces));
  if (options.slabColor) regions.set(BACKGROUND, covered ? facesOf(cut(canvas, covered)) : [canvas]);
  regions = absorbSlivers(regions, options.minArea, Math.max(svg.width, svg.height) * 1e-6);
  const background = regions.get(BACKGROUND) ?? [];
  regions.delete(BACKGROUND);

  const parts: Part[] = [];
  if (options.mode === "puzzle") {
    background.forEach((face, i) => parts.push({
      solid: extrude(face, 0, options.height), label: `background-${i + 1}`, color: options.slabColor!, level: 0,
    }));
    for (const [key, faces] of regions) {
      faces.forEach((face, i) => parts.push({
        solid: extrude(face, 0, options.height), label: `${key}-${i + 1}`, color: colorOf.get(key)!, level: 1,
      }));
    }
  } else {
    const totalArea = (faces: TopoDS_Face[]) => faces.reduce((sum, f) => sum + area(f), 0);
    const layers = [...regions]
      .map(([key, faces]) => ({ key, color: colorOf.get(key)!, faces, area: totalArea(faces) }))
      .sort((a, b) => (options.order === "large" ? b.area - a.area : a.area - b.area));
    if (options.slabColor) layers.unshift({ key: BACKGROUND, color: options.slabColor, faces: background, area: 0 });
    const thicknesses = layerThicknesses(layers.length, options.height, options.layerThickness);
    layers.forEach(({ color }, level) => {
      const z = thicknesses.slice(0, level).reduce((a, b) => a + b, 0);
      const footprint = layers.slice(level).flatMap((layer) => layer.faces);
      mergeTouching(footprint).forEach((face, i) => parts.push({
        solid: extrude(face, z, thicknesses[level]),
        label: `L${level + 1}-${toHex(color)}-${i + 1}`,
        color,
        level,
      }));
    });
  }
  return { parts, colors: byColor.size, width: svg.width, height: svg.height };
}

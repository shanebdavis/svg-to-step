/**
 * SVG to colored solids. Mirrors svg2step.py:
 *
 * Puzzle mode: the canvas, or a square, circle or hexagon wrapped around the
 * art, becomes a slab with every painted shape cut out of it, and each visible connected single-color region is a solid filling its
 * cutout exactly. An optional single-color base sits under the puzzle.
 *
 * Layers mode: one layer per color, stacked by area. Each layer covers its own
 * color plus every color above it, so each color shows from the top at its
 * own step height.
 *
 * Either way, overlaps resolve by paint order, so the top view matches the SVG,
 * and the finished footprint's longest side is exactly the requested size.
 * An optional color limit merges the most alike colors first.
 */

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopoDS_Solid } from "replicad-opencascadejs";
import { toHex, type RGB } from "./svg/color";
import { parseSvg } from "./svg/parseSvg";
import { areaPathsD, FillRule as Fill, getBoundsPathsD, intersectD, unionD, type PathsD } from "clipper2-ts";
import { flatten, type Point } from "./svg/geometry";
import type { ParsedSvg } from "./svg/parseSvg";
import {
  area, boundingBox, common, cut, distanceToPoint, edgeLength, edgeSamples, edgesOf, extrude, faceFromWires,
  facesFromContours, facesOf, fuse, mesh, rectangleFace, repairFace, scale, unifyFaces, wireFromContour, withoutHoles, type Box,
} from "./occt/kernel";
import { reduceColors } from "./reduceColors";
import { wrapContour, type WrapShape } from "./wrap";

export interface BuildOptions {
  /**
   * Longest side of the finished footprint, mm: the slab, or without one, the
   * art. The art scales to fit, so padding and feature sizes stay true.
   */
  size: number;
  /** Total height, mm. */
  height: number;
  /** Slab color, "auto" for the SVG color covering the most area, or null for no slab. */
  slabColor: RGB | "auto" | null;
  /** The canvas rectangle, or a shape wrapped around the visible art. */
  slabShape: "canvas" | WrapShape;
  /** Gap between the art and a wrapped slab's edge, mm. */
  slabPadding: number;
  mode: "puzzle" | "layers";
  /** Layers mode: which colors sit lowest. */
  order: "large" | "small";
  /** Layers mode: fixed thickness, or null to split the height evenly. */
  layerThickness: number | null;
  /**
   * Puzzle mode: thickness of a solid base under the puzzle, or null for no base.
   * The base covers the slab, or without one, the outline of the art with holes filled.
   */
  baseThickness: number | null;
  /** Base color, or null for the color covering the most area. */
  baseColor: RGB | null;
  /** Most colors to keep from the SVG, or null for all. */
  maxColors: number | null;
  /** Strokes narrower than this (mm) widen to it; 0 leaves them as drawn. */
  minStroke: number;
  /** Regions under this area (mm²) merge into a neighbor. */
  minArea: number;
}

const GRAY: RGB = [128 / 255, 128 / 255, 128 / 255];

export const DEFAULT_OPTIONS: BuildOptions = {
  size: 100, height: 5, slabColor: GRAY, slabShape: "canvas", slabPadding: 5,
  mode: "puzzle", order: "large", layerThickness: null, baseThickness: null, baseColor: null, maxColors: null,
  minStroke: 0, minArea: 0.5,
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
  /** Each SVG color and its visible area (mm²), largest first. */
  palette: { color: RGB; area: number }[];
  /** Distinct visible colors in the SVG, before any color limit. */
  svgColors: number;
  /** How much the SVG was scaled to fit size. */
  fit: number;
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

const totalArea = (faces: TopoDS_Face[]) => faces.reduce((sum, f) => sum + area(f), 0);

/** Regrouped by color once reduceColors merges down to count; colorOf learns the merged colors. */
function limitColors(byColor: Map<Key, TopoDS_Face[]>, colorOf: Map<Key, RGB>, count: number | null) {
  if (count === null || byColor.size <= count) return byColor;
  const keys = [...byColor.keys()];
  const colors = reduceColors(keys.map((key) => ({ color: colorOf.get(key)!, area: totalArea(byColor.get(key)!) })), count);
  const merged = new Map<Key, TopoDS_Face[]>();
  keys.forEach((key, i) => {
    const hex = toHex(colors[i]);
    colorOf.set(hex, colors[i]);
    merged.set(hex, [...(merged.get(hex) ?? []), ...byColor.get(key)!]);
  });
  return merged;
}

/** Fuse same-color fragments, then split into connected regions. */
function mergeTouching(faces: TopoDS_Face[]): TopoDS_Face[] {
  return faces.length <= 1 ? faces : facesOf(unifyFaces(fuse(faces)));
}

/** Outer boundary of faces: their union with holes filled, so islands inside a hole merge too. */
const outline = (faces: TopoDS_Face[]) => mergeTouching(mergeTouching(faces).map(withoutHoles));

function overlaps(a: Box, b: Box, tolerance: number): boolean {
  return !(b.minX > a.maxX + tolerance || b.maxX < a.minX - tolerance ||
    b.minY > a.maxY + tolerance || b.maxY < a.minY - tolerance);
}

interface Piece { key: Key; face: TopoDS_Face; box: Box; area: number; edges?: { edge: TopoDS_Edge; box: Box }[] }

const piece = (key: Key, face: TopoDS_Face): Piece => ({ key, face, box: boundingBox(face), area: area(face) });

/**
 * Distance from a point on a sliver's border to a piece's border, or Infinity
 * when no edge of the piece comes within tolerance. Only edges whose bounding
 * box is near the point are measured: whole-face distances are slow on faces
 * with many edges.
 */
function borderDistance(piece: Piece, [x, y]: Point, tolerance: number): number {
  piece.edges ??= edgesOf(piece.face).map((edge) => ({ edge, box: boundingBox(edge) }));
  let best = Infinity;
  for (const { edge, box } of piece.edges) {
    if (x < box.minX - tolerance || x > box.maxX + tolerance || y < box.minY - tolerance || y > box.maxY + tolerance) continue;
    best = Math.min(best, distanceToPoint(edge, [x, y]));
  }
  return best;
}

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
        const distance = borderDistance(pieces[i], point as Point, tolerance);
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

/** The slab outline: the canvas, or a shape around the art clipped to the canvas. */
function slabFace(options: BuildOptions, canvas: TopoDS_Face, covered: TopoDS_Shape | null) {
  if (!options.slabColor || options.slabShape === "canvas" || !covered) return { slab: canvas, art: covered };
  const art = common(covered, canvas);
  const box = boundingBox(art);
  const { positions } = mesh(art, Math.max(box.maxX - box.minX, box.maxY - box.minY) * 1e-4, 0.05);
  const points = Array.from({ length: positions.length / 3 }, (_, i): Point => [positions[3 * i], positions[3 * i + 1]]);
  const wire = wireFromContour(wrapContour(points, options.slabShape, options.slabPadding));
  return { slab: faceFromWires(wire, []), art };
}

/**
 * How much to scale the SVG so the footprint's longest side is size: 1 for a
 * canvas slab, else from the visible art's extent. A wrapped slab's extent is
 * the art's times the scale plus a fixed padding term, so two samples solve it.
 */
function fitScale(svg: ParsedSvg, kept: Point[][][], options: BuildOptions): number {
  const slab = options.slabColor !== null;
  if (slab && options.slabShape === "canvas") return 1;
  const canvas = toPaths([[[0, 0], [svg.width, 0], [svg.width, svg.height], [0, svg.height]]]);
  const art = intersectD(unionD(toPaths(kept.flat()), Fill.NonZero), canvas, Fill.NonZero, 4);
  if (Math.abs(areaPathsD(art)) === 0) return 1;
  const points = art.flatMap((path) => path.map(({ x, y }): Point => [x, y]));
  const extent = (k: number) => {
    if (!slab) {
      const box = getBoundsPathsD(art);
      return [(box.right - box.left) * k, (box.bottom - box.top) * k];
    }
    const contour = wrapContour(points.map(([x, y]) => [x * k, y * k]), options.slabShape as WrapShape, options.slabPadding);
    if (contour.kind === "circle") return [2 * contour.radius, 2 * contour.radius];
    if (contour.kind !== "path") throw new Error("Unexpected slab outline");
    const corners = contour.segments.map((s) => s.from);
    const span = (i: 0 | 1) => Math.max(...corners.map((c) => c[i])) - Math.min(...corners.map((c) => c[i]));
    return [span(0), span(1)];
  };
  const [one, two] = [extent(1), extent(2)];
  return Math.min(...[0, 1].map((i) => {
    const slope = two[i] - one[i];
    return slope > 0 ? (options.size - (one[i] - slope)) / slope : Infinity;
  }));
}

const toPaths = (polygons: Point[][]): PathsD => polygons.map((p) => p.map(([x, y]) => ({ x, y })));

export function build(svgText: string, options: BuildOptions): Model {
  const parse = (size: number) => parseSvg(svgText, size, options.minStroke);
  const nominal = parse(options.size);
  let fit = fitScale(nominal, nominal.shapes.map((shape) => shape.contours.map((c) => flatten(c, 16))), options);
  const svg = fit === 1 ? nominal : parse(options.size * fit);
  const colorOf = new Map<Key, RGB>();
  const painted = svg.shapes.flatMap((shape) => {
    const key = toHex(shape.color);
    colorOf.set(key, shape.color);
    return facesFromContours(shape.contours, shape.fillRule).flatMap(repairFace).map((face) => ({ face, key }));
  });
  const canvas = rectangleFace(svg.width, svg.height);

  const { byColor, covered } = visibleRegions(painted, canvas);
  let regions = new Map<Key, TopoDS_Face[]>();
  for (const [key, faces] of limitColors(byColor, colorOf, options.maxColors)) regions.set(key, mergeTouching(faces));
  const { slab: slabOutline, art } = slabFace(options, canvas, covered);
  let slab = slabOutline;
  if (options.slabColor) regions.set(BACKGROUND, art ? facesOf(cut(slab, art)) : [slab]);
  regions = absorbSlivers(regions, options.minArea, Math.max(svg.width, svg.height) * 1e-6);
  const background = regions.get(BACKGROUND) ?? [];
  regions.delete(BACKGROUND);
  const palette = [...regions]
    .map(([key, faces]) => ({ color: colorOf.get(key)!, area: totalArea(faces) }))
    .sort((a, b) => b.area - a.area);

  const slabColor = options.slabColor === "auto" ? palette[0]?.color ?? GRAY : options.slabColor;

  // Exact fit: whatever the steps above grew (thickening past the art, say), the longest side is size.
  const footprint = [...regions.values(), background, options.slabColor ? [slab] : []].flat().map((f) => boundingBox(f, true));
  if (footprint.length) {
    const span = (lo: "minX" | "minY", hi: "maxX" | "maxY") =>
      Math.max(...footprint.map((b) => b[hi])) - Math.min(...footprint.map((b) => b[lo]));
    const factor = options.size / Math.max(span("minX", "maxX"), span("minY", "maxY"));
    if (Math.abs(factor - 1) > 1e-9) {
      const rescale = (faces: TopoDS_Face[]) => faces.map((f) => facesOf(scale(f, factor))[0]);
      for (const [key, faces] of regions) regions.set(key, rescale(faces));
      background.splice(0, background.length, ...rescale(background));
      slab = facesOf(scale(slab, factor))[0];
      fit *= factor;
    }
  }
  const parts: Part[] = [];
  if (options.mode === "puzzle") {
    let z = 0;
    let level = 0;
    const { baseThickness } = options;
    if (baseThickness) {
      const color = options.baseColor ?? palette[0]?.color ?? slabColor ?? GRAY;
      const footprint = options.slabColor ? [slab] : outline([...regions.values()].flat());
      footprint.forEach((face, i) => parts.push({
        solid: extrude(face, 0, baseThickness), label: `base-${i + 1}`, color, level: 0,
      }));
      z = baseThickness;
      level = 1;
    }
    background.forEach((face, i) => parts.push({
      solid: extrude(face, z, options.height), label: `background-${i + 1}`, color: slabColor!, level,
    }));
    for (const [key, faces] of regions) {
      faces.forEach((face, i) => parts.push({
        solid: extrude(face, z, options.height), label: `${key}-${i + 1}`, color: colorOf.get(key)!, level: level + 1,
      }));
    }
  } else {
    const layers = [...regions]
      .map(([key, faces]) => ({ key, color: colorOf.get(key)!, faces, area: totalArea(faces) }))
      .sort((a, b) => (options.order === "large" ? b.area - a.area : a.area - b.area));
    if (slabColor) layers.unshift({ key: BACKGROUND, color: slabColor, faces: background, area: 0 });
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
  return { parts, palette, svgColors: byColor.size, fit, width: svg.width, height: svg.height };
}

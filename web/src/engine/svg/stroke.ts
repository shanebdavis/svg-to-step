/**
 * SVG strokes as filled outlines: the center line offset by half the stroke
 * width on both sides, with the stroke's caps and joins. Dashes are ignored.
 */

import { EndType, inflatePathsD, JoinType, unionD, FillRule, type PathD } from "clipper2-ts";
import { flatten, type Contour, type Point } from "./geometry";

export interface StrokeStyle {
  /** mm */
  width: number;
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
  miterLimit: number;
}

const ENDS = { butt: EndType.Butt, round: EndType.Round, square: EndType.Square };
const JOINS = { miter: JoinType.Miter, round: JoinType.Round, bevel: JoinType.Bevel };

const toPath = (points: Point[]): PathD => points.map(([x, y]) => ({ x, y }));

/** Polygon outlines of the stroke, as contours to fill with nonzero. */
export function strokeOutline(contours: Contour[], style: StrokeStyle): Contour[] {
  const closed: PathD[] = [];
  const open: PathD[] = [];
  for (const contour of contours) {
    if (contour.kind === "path" && contour.open) {
      const segments = contour.segments.slice(0, -1);
      const points = flatten({ kind: "path", segments }, 16);
      open.push(toPath([...points, segments[segments.length - 1].to]));
    } else closed.push(toPath(flatten(contour, 16)));
  }
  const half = style.width / 2;
  const offset = (paths: PathD[], end: EndType) => (paths.length
    ? inflatePathsD(paths, half, JOINS[style.join], end, style.miterLimit, 4, half / 500)
    : []);
  const outline = unionD([...offset(closed, EndType.Joined), ...offset(open, ENDS[style.cap])], FillRule.NonZero);
  return outline.map((path) => ({
    kind: "path",
    segments: path.map((p, i) => {
      const q = path[(i + 1) % path.length];
      return { kind: "line", from: [p.x, p.y], to: [q.x, q.y] };
    }),
  }));
}

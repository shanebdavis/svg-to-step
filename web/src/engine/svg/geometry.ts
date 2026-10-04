/** 2D geometry shared by the SVG parser and the CAD builder. */

export type Point = readonly [number, number];

/** Affine transform [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (SVG order). */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Matrix, [x, y]: Point): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Uniform scale, rotation, translation and optional mirroring: circles stay circles. */
export function isSimilarity(m: Matrix, epsilon = 1e-9): boolean {
  const xLength = m[0] * m[0] + m[1] * m[1];
  const yLength = m[2] * m[2] + m[3] * m[3];
  const dot = m[0] * m[2] + m[1] * m[3];
  const scale = Math.max(xLength, yLength, 1e-300);
  return Math.abs(xLength - yLength) <= epsilon * scale && Math.abs(dot) <= epsilon * scale;
}

/** Scale factor of a similarity transform. */
export function similarityScale(m: Matrix): number {
  return Math.hypot(m[0], m[1]);
}

export type Segment =
  | { kind: "line"; from: Point; to: Point }
  | { kind: "cubic"; from: Point; c1: Point; c2: Point; to: Point }
  /** Circular arc through three points. */
  | { kind: "arc"; from: Point; via: Point; to: Point };

/** A closed outline: either a chain of segments or a whole circle/ellipse. */
export type Contour =
  | { kind: "path"; segments: Segment[] }
  | { kind: "circle"; center: Point; radius: number }
  | { kind: "ellipse"; center: Point; rx: number; ry: number; /** radians, x axis */ angle: number };

export function transformSegment(m: Matrix, s: Segment): Segment {
  switch (s.kind) {
    case "line":
      return { kind: "line", from: apply(m, s.from), to: apply(m, s.to) };
    case "cubic":
      return { kind: "cubic", from: apply(m, s.from), c1: apply(m, s.c1), c2: apply(m, s.c2), to: apply(m, s.to) };
    case "arc":
      return { kind: "arc", from: apply(m, s.from), via: apply(m, s.via), to: apply(m, s.to) };
  }
}

const KAPPA = (4 * (Math.SQRT2 - 1)) / 3;

/** Ellipse as four cubic Beziers, in its local frame mapped through m. */
export function ellipseCubics(m: Matrix, cx: number, cy: number, rx: number, ry: number): Segment[] {
  const p = (x: number, y: number): Point => apply(m, [cx + x, cy + y]);
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    { kind: "cubic", from: p(rx, 0), c1: p(rx, ky), c2: p(kx, ry), to: p(0, ry) },
    { kind: "cubic", from: p(0, ry), c1: p(-kx, ry), c2: p(-rx, ky), to: p(-rx, 0) },
    { kind: "cubic", from: p(-rx, 0), c1: p(-rx, -ky), c2: p(-kx, -ry), to: p(0, -ry) },
    { kind: "cubic", from: p(0, -ry), c1: p(kx, -ry), c2: p(rx, -ky), to: p(rx, 0) },
  ];
}

/** Map a circle/ellipse through m: exact when m is a similarity, Beziers otherwise. */
export function transformedEllipse(m: Matrix, cx: number, cy: number, rx: number, ry: number): Contour {
  if (!isSimilarity(m)) return { kind: "path", segments: ellipseCubics(m, cx, cy, rx, ry) };
  const center = apply(m, [cx, cy]);
  const scale = similarityScale(m);
  if (rx === ry) return { kind: "circle", center, radius: rx * scale };
  return { kind: "ellipse", center, rx: rx * scale, ry: ry * scale, angle: Math.atan2(m[1], m[0]) };
}

/** Points along a contour, for containment tests. */
export function flatten(contour: Contour, perCurve = 16): Point[] {
  if (contour.kind === "circle" || contour.kind === "ellipse") {
    const [rx, ry, angle] = contour.kind === "circle" ? [contour.radius, contour.radius, 0] : [contour.rx, contour.ry, contour.angle];
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const n = perCurve * 4;
    return Array.from({ length: n }, (_, i) => {
      const t = (2 * Math.PI * i) / n;
      const x = rx * Math.cos(t);
      const y = ry * Math.sin(t);
      return [contour.center[0] + x * cos - y * sin, contour.center[1] + x * sin + y * cos] as Point;
    });
  }
  const points: Point[] = [];
  for (const s of contour.segments) {
    points.push(s.from);
    if (s.kind === "cubic") {
      for (let i = 1; i < perCurve; i++) points.push(cubicAt(s, i / perCurve));
    } else if (s.kind === "arc") {
      points.push(...arcPoints(s, perCurve).slice(1, -1));
    }
  }
  return points;
}

function cubicAt(s: Extract<Segment, { kind: "cubic" }>, t: number): Point {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [
    a * s.from[0] + b * s.c1[0] + c * s.c2[0] + d * s.to[0],
    a * s.from[1] + b * s.c1[1] + c * s.c2[1] + d * s.to[1],
  ];
}

/** Circle through three points, or null when they are collinear. */
export function circleThrough(a: Point, b: Point, c: Point): { center: Point; radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const sq = (p: Point) => p[0] * p[0] + p[1] * p[1];
  const center: Point = [
    (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d,
    (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d,
  ];
  return { center, radius: Math.hypot(a[0] - center[0], a[1] - center[1]) };
}

function arcPoints(s: Extract<Segment, { kind: "arc" }>, n: number): Point[] {
  const circle = circleThrough(s.from, s.via, s.to);
  if (!circle) return [s.from, s.to];
  const { center, radius } = circle;
  const angle = (p: Point) => Math.atan2(p[1] - center[1], p[0] - center[0]);
  const a0 = angle(s.from);
  const sweep = (target: number) => ((target - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  // Go the way that passes through `via`.
  let delta = sweep(angle(s.to));
  if (sweep(angle(s.via)) > delta) delta -= 2 * Math.PI;
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = a0 + (delta * i) / n;
    return [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)] as Point;
  });
}

export function polygonArea(points: readonly Point[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j][0] - points[i][0]) * (points[j][1] + points[i][1]);
  }
  return area / 2;
}

export function pointInPolygon([x, y]: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Winding number of closed polygons around a point. */
export function windingNumber([x, y]: Point, polygons: readonly (readonly Point[])[]): number {
  let winding = 0;
  for (const polygon of polygons) {
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [x0, y0] = polygon[j];
      const [x1, y1] = polygon[i];
      const side = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);
      if (y0 <= y && y1 > y && side > 0) winding++;
      else if (y0 > y && y1 <= y && side < 0) winding--;
    }
  }
  return winding;
}

function segmentsTouch(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (o: Point, p: Point, q: Point) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (o: Point, p: Point, q: Point) =>
    Math.min(o[0], p[0]) <= q[0] && q[0] <= Math.max(o[0], p[0]) && Math.min(o[1], p[1]) <= q[1] && q[1] <= Math.max(o[1], p[1]);
  return (d1 === 0 && on(c, d, a)) || (d2 === 0 && on(c, d, b)) || (d3 === 0 && on(a, b, c)) || (d4 === 0 && on(a, b, d));
}

/**
 * Whether any polygon crosses itself or another. Conservative: touching
 * counts too, which only routes the shape through the slower general path.
 */
export function polygonsCross(polygons: readonly (readonly Point[])[]): boolean {
  const edges = polygons.flatMap((polygon, p) => polygon.map((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    return {
      p, i, n: polygon.length, a, b,
      minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]),
    };
  }));
  edges.sort((e, f) => e.minX - f.minX);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    for (let j = i + 1; j < edges.length && edges[j].minX <= e.maxX; j++) {
      const f = edges[j];
      if (f.minY > e.maxY || f.maxY < e.minY) continue;
      // Neighbors along the same polygon share an endpoint by construction.
      if (e.p === f.p && (Math.abs(e.i - f.i) === 1 || Math.abs(e.i - f.i) === e.n - 1)) continue;
      if (segmentsTouch(e.a, e.b, f.a, f.b)) return true;
    }
  }
  return false;
}

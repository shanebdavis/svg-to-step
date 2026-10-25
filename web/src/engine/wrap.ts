/** Smallest square, circle or hexagon around a set of points, grown by a padding. */

import type { Contour, Point } from "./svg/geometry";

export type WrapShape = "square" | "circle" | "hexagon";

const polygon = (corners: Point[]): Contour => ({
  kind: "path",
  segments: corners.map((from, i) => ({ kind: "line", from, to: corners[(i + 1) % corners.length] })),
});

export function wrapContour(points: Point[], shape: WrapShape, padding: number): Contour {
  if (shape === "circle") {
    const { center, radius } = enclosingCircle(points);
    return { kind: "circle", center, radius: radius + padding };
  }
  if (shape === "hexagon") {
    const { center, apothem } = enclosingHexagon(points);
    const r = ((apothem + padding) * 2) / Math.sqrt(3);
    return polygon(Array.from({ length: 6 }, (_, i) => [
      center[0] + r * Math.cos((i * Math.PI) / 3), center[1] + r * Math.sin((i * Math.PI) / 3),
    ]));
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [cx, cy] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const half = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 + padding;
  return polygon([[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]]);
}

interface Circle { center: Point; radius: number }

const contains = (c: Circle, [x, y]: Point) => Math.hypot(x - c.center[0], y - c.center[1]) <= c.radius * (1 + 1e-9) + 1e-9;

const diameter = (a: Point, b: Point): Circle => ({
  center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
  radius: Math.hypot(a[0] - b[0], a[1] - b[1]) / 2,
});

function circumcircle(a: Point, b: Point, c: Point): Circle {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) {
    // Collinear: the two farthest-apart points span it.
    return [diameter(a, b), diameter(a, c), diameter(b, c)].reduce((x, y) => (y.radius > x.radius ? y : x));
  }
  const sq = (p: Point) => p[0] * p[0] + p[1] * p[1];
  const x = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
  const y = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
  return { center: [x, y], radius: Math.hypot(a[0] - x, a[1] - y) };
}

/** Minimum enclosing circle (Welzl, iterative), expected linear time on shuffled input. */
export function enclosingCircle(input: Point[]): Circle {
  const p = [...input];
  for (let i = p.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  let c: Circle = { center: p[0] ?? [0, 0], radius: 0 };
  for (let i = 1; i < p.length; i++) {
    if (contains(c, p[i])) continue;
    c = { center: p[i], radius: 0 };
    for (let j = 0; j < i; j++) {
      if (contains(c, p[j])) continue;
      c = diameter(p[i], p[j]);
      for (let k = 0; k < j; k++) if (!contains(c, p[k])) c = circumcircle(p[i], p[j], p[k]);
    }
  }
  return c;
}

/**
 * Smallest regular hexagon with a vertex on the +X axis. Its three edge
 * normals n1 = n2 + n3 make this a small closed-form problem: each normal
 * gives a strip of half-width w and midline m the hexagon must cover.
 */
export function enclosingHexagon(points: Point[]): { center: Point; apothem: number } {
  const s = Math.sqrt(3) / 2;
  const normals: Point[] = [[0, 1], [s, 0.5], [-s, 0.5]];
  const [[m1, w1], [m2, w2], [m3, w3]] = normals.map(([nx, ny]) => {
    const d = points.map(([x, y]) => nx * x + ny * y);
    const [lo, hi] = [Math.min(...d), Math.max(...d)];
    return [(hi + lo) / 2, (hi - lo) / 2];
  });
  // The center's offsets along n2 and n3 must sum to its offset along n1, within each strip's slack.
  const e = m1 - m2 - m3;
  const apothem = Math.max(w1, w2, w3, (Math.abs(e) + w1 + w2 + w3) / 3);
  const [r2, r3] = [apothem - w2, apothem - w3];
  const t = Math.max(-(r2 + r3), Math.min(r2 + r3, e));
  const u2 = m2 + (r2 + r3 > 0 ? (t * r2) / (r2 + r3) : 0);
  const u3 = m3 + (r2 + r3 > 0 ? (t * r3) / (r2 + r3) : 0);
  return { center: [(u2 - u3) / (2 * s), u2 + u3], apothem };
}

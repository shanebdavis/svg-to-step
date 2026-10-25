/**
 * Center lines of polygon regions (the chordal axis): triangulate the region,
 * then join the midpoints of the edges shared by two triangles. Each such
 * chord spans the region from side to side, so its midpoint sits midway
 * between the edges and its length is the local width. A chord whose ends lie
 * close together along the outline cuts across a corner instead, and measures
 * nothing; those are marked as such.
 *
 * Model millimeters, Y up.
 */

import Constrainautor from "@kninnug/constrainautor";
import type { PathsD } from "clipper2-ts";
import Delaunator from "delaunator";
import { windingNumber, type Point } from "./svg/geometry";

export interface Axis {
  points: Point[];
  /** Local width at each point. */
  widths: number[];
  /** Points on chords that cut across a corner rather than measuring a width. */
  corners: Set<number>;
  /** Points at chord midpoints: the ones that measure a width themselves. */
  chords: Set<number>;
  /** Neighbors of each point. */
  links: Set<number>[];
  /** Points dropped by pruning. */
  pruned: Set<number>;
}

const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The outlines with no edge longer than spacing, so triangles span the region rather than run along it. */
function resample(paths: PathsD, spacing: number) {
  return paths.map((path) => {
    let along = 0;
    const points = path.flatMap((p, i) => {
      const q = path[(i + 1) % path.length];
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      const steps = Math.max(1, Math.ceil(length / spacing));
      const added = Array.from({ length: steps }, (_, k) =>
        ({ point: [p.x + ((q.x - p.x) * k) / steps, p.y + ((q.y - p.y) * k) / steps] as Point, along: along + (length * k) / steps }));
      along += length;
      return added;
    });
    return { perimeter: along, points };
  });
}

/** Constrained Delaunay triangles inside the outlines, as point index triples, plus each triangle's neighbors. */
function triangulate(loops: Point[][]) {
  const ids = new Map<string, number>();
  const points: Point[] = [];
  const id = (p: Point) => {
    const key = `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;
    if (!ids.has(key)) {
      ids.set(key, points.length);
      points.push(p);
    }
    return ids.get(key)!;
  };
  const loopIds = loops.map((loop) => loop.map(id));
  const edges = loopIds.flatMap((loop) => loop.flatMap((a, i): [number, number][] => {
    const b = loop[(i + 1) % loop.length];
    return a === b ? [] : [[a, b]];
  }));
  const delaunay = new Delaunator(points.flat());
  new Constrainautor(delaunay, edges);
  const { triangles, halfedges } = delaunay;
  const corner = (t: number, k: number) => points[triangles[3 * t + k]];
  const count = triangles.length / 3;
  const inside = Array.from({ length: count }, (_, t) => {
    const [a, b, c] = [0, 1, 2].map((k) => corner(t, k));
    return windingNumber([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3], loops) !== 0;
  });
  return { points, loopIds, triangles, halfedges, inside, count };
}

export function chordalAxis(region: PathsD, spacing: number): Axis {
  const axis: Axis = { points: [], widths: [], corners: new Set(), chords: new Set(), links: [], pruned: new Set() };
  const add = (p: Point, width: number) => {
    axis.points.push(p);
    axis.widths.push(width);
    axis.links.push(new Set());
    return axis.points.length - 1;
  };
  const link = (a: number, b: number) => {
    axis.links[a].add(b);
    axis.links[b].add(a);
  };
  const loops = resample(region, spacing);
  let mesh: ReturnType<typeof triangulate>;
  try {
    mesh = triangulate(loops.map((loop) => loop.points.map((p) => p.point)));
  } catch {
    // Outlines the triangulator can't take (touching or crossing edges): no center line.
    return axis;
  }
  const { points, loopIds, triangles, halfedges, inside, count } = mesh;
  const place = new Map<number, { loop: number; along: number }>();
  loopIds.forEach((ids, loop) => ids.forEach((id, i) => place.set(id, { loop, along: loops[loop].points[i].along })));
  /** True when a chord's ends are close along the outline: it cuts a corner (60° or wider) off. */
  const cutsCorner = (a: number, b: number, width: number) => {
    const [pa, pb] = [place.get(a), place.get(b)];
    if (!pa || !pb || pa.loop !== pb.loop) return false;
    const gap = Math.abs(pa.along - pb.along);
    return Math.min(gap, loops[pa.loop].perimeter - gap) <= 2 * width;
  };
  const chords = new Map<number, number>();
  /** The axis point on the edge at halfedge h, if that edge is shared by two triangles inside the region. */
  const chord = (h: number) => {
    const opposite = halfedges[h];
    if (opposite < 0 || !inside[Math.floor(opposite / 3)]) return null;
    const e = Math.min(h, opposite);
    if (!chords.has(e)) {
      const [a, b] = [triangles[h], triangles[h % 3 === 2 ? h - 2 : h + 1]];
      const [pa, pb] = [points[a], points[b]];
      const width = distance(pa, pb);
      const node = add([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2], width);
      axis.chords.add(node);
      if (cutsCorner(a, b, width)) axis.corners.add(node);
      chords.set(e, node);
    }
    return chords.get(e)!;
  };
  for (let t = 0; t < count; t++) {
    if (!inside[t]) continue;
    const corners = [0, 1, 2].map((k) => points[triangles[3 * t + k]]);
    const center: Point = [(corners[0][0] + corners[1][0] + corners[2][0]) / 3, (corners[0][1] + corners[1][1] + corners[2][1]) / 3];
    const inner = [0, 1, 2].flatMap((k) => {
      const node = chord(3 * t + k);
      return node === null ? [] : [{ k, node }];
    });
    const nodes = inner.map((i) => i.node);
    if (nodes.length === 2) link(nodes[0], nodes[1]);
    else if (nodes.length === 3) {
      const junction = add(center, Math.max(...nodes.map((n) => axis.widths[n])));
      for (const n of nodes) link(junction, n);
    } else if (nodes.length === 1) {
      // An end: stop half a width short of the tip, equally far from the tip and both sides.
      const middle = axis.points[nodes[0]];
      const tip = corners[(inner[0].k + 2) % 3];
      const half = axis.widths[nodes[0]] / 2;
      const reach = distance(middle, tip);
      if (reach > half) {
        const f = (reach - half) / reach;
        const end = add([middle[0] + (tip[0] - middle[0]) * f, middle[1] + (tip[1] - middle[1]) * f], axis.widths[nodes[0]]);
        if (axis.corners.has(nodes[0])) axis.corners.add(end);
        link(nodes[0], end);
      }
    } else {
      add(center, Math.max(...[0, 1, 2].map((k) => distance(corners[k], corners[(k + 1) % 3]))));
    }
  }
  prune(axis);
  return axis;
}

function remove(axis: Axis, i: number) {
  for (const j of axis.links[i]) axis.links[j].delete(i);
  axis.links[i].clear();
  axis.pruned.add(i);
}

/**
 * Drop side branches that end inside the widest circle at their junction:
 * bulges in the outline, not features. Each bulge of a curved side makes one.
 */
function prune(axis: Axis) {
  for (let changed = true; changed;) {
    changed = false;
    for (let leaf = 0; leaf < axis.points.length; leaf++) {
      if (axis.links[leaf].size !== 1) continue;
      const branch = [leaf];
      let length = 0;
      let [previous, current] = [leaf, [...axis.links[leaf]][0]];
      while (axis.links[current].size === 2) {
        branch.push(current);
        length += distance(axis.points[previous], axis.points[current]);
        [previous, current] = [current, [...axis.links[current]].find((n) => n !== previous)!];
      }
      length += distance(axis.points[previous], axis.points[current]);
      if (axis.links[current].size >= 3 && length < 0.625 * axis.widths[current]) {
        for (const i of branch) remove(axis, i);
        changed = true;
      }
    }
  }
}

/** Move chain points toward their neighbors' midpoint; ends and junctions stay. */
export function smooth(axis: Axis, nodes: Set<number>, rounds = 6) {
  const chain = [...nodes].filter((i) => axis.links[i].size === 2 && [...axis.links[i]].every((n) => nodes.has(n)));
  for (let round = 0; round < rounds; round++) {
    const moved = chain.map((i) => {
      const [a, b] = [...axis.links[i]].map((n) => axis.points[n]);
      const p = axis.points[i];
      return [p[0] / 2 + (a[0] + b[0]) / 4, p[1] / 2 + (a[1] + b[1]) / 4] as Point;
    });
    chain.forEach((i, k) => { axis.points[i] = moved[k]; });
  }
}

/** The axis edges among nodes as polylines, joined through points with exactly two such edges. */
export function polylines(axis: Axis, nodes: Set<number>): Point[][] {
  const neighbors = (i: number) => [...axis.links[i]].filter((n) => nodes.has(n));
  const done = new Set<string>();
  const edge = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const lines: Point[][] = [];
  const walk = (start: number, next: number) => {
    const line = [start];
    let [previous, current] = [start, next];
    done.add(edge(previous, current));
    while (true) {
      line.push(current);
      const onward = neighbors(current).filter((n) => !done.has(edge(current, n)));
      if (neighbors(current).length !== 2 || !onward.length) break;
      [previous, current] = [current, onward[0]];
      done.add(edge(previous, current));
    }
    lines.push(line.map((i) => axis.points[i]));
  };
  const ordered = [...nodes].sort((a, b) => Number(neighbors(a).length === 2) - Number(neighbors(b).length === 2));
  for (const i of ordered) {
    const around = neighbors(i);
    if (!around.length) lines.push([axis.points[i]]);
    for (const n of around) if (!done.has(edge(i, n))) walk(i, n);
  }
  return lines;
}

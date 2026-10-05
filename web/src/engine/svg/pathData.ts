/** SVG path data ("d" attribute) to closed contours. */

import { apply, isSimilarity, transformSegment, type Contour, type Matrix, type Point, type Segment } from "./geometry";

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

class Scanner {
  private i = 0;
  constructor(private readonly text: string) {}

  private skip(): void {
    while (this.i < this.text.length && /[\s,]/.test(this.text[this.i])) this.i++;
  }

  done(): boolean {
    this.skip();
    return this.i >= this.text.length;
  }

  command(): string | null {
    this.skip();
    const c = this.text[this.i];
    return c && /[a-zA-Z]/.test(c) ? (this.i++, c) : null;
  }

  number(): number {
    this.skip();
    const match = NUMBER.exec(this.text.slice(this.i));
    if (!match) throw new SyntaxError(`expected a number at ${this.i} in path data`);
    this.i += match[0].length;
    return Number(match[0]);
  }

  /** Arc flags may be written without separators, e.g. "a1 1 0 011 1". */
  flag(): boolean {
    this.skip();
    const c = this.text[this.i];
    if (c !== "0" && c !== "1") throw new SyntaxError(`expected an arc flag at ${this.i} in path data`);
    this.i++;
    return c === "1";
  }
}

/** Parse path data into closed contours mapped through m. Every subpath closes, as filling does. */
export function pathContours(d: string, m: Matrix): Contour[] {
  const contours: Contour[] = [];
  const scanner = new Scanner(d);
  let segments: Segment[] = [];
  let current: Point = [0, 0];
  let start: Point = [0, 0];
  let lastControl: Point | null = null;
  let lastQuadControl: Point | null = null;
  let command: string | null = null;

  const push = (s: Segment) => {
    const t = transformSegment(m, s);
    if (t.from[0] !== t.to[0] || t.from[1] !== t.to[1] || t.kind !== "line") segments.push(t);
  };

  const finish = () => {
    if (segments.length) {
      const first = segments[0].from;
      const last = segments[segments.length - 1].to;
      if (first[0] !== last[0] || first[1] !== last[1]) segments.push({ kind: "line", from: last, to: first });
      contours.push({ kind: "path", segments });
    }
    segments = [];
  };

  while (!scanner.done()) {
    command = scanner.command() ?? (command === "M" ? "L" : command === "m" ? "l" : command);
    if (!command) throw new SyntaxError("path data must start with a command");
    const relative = command === command.toLowerCase();
    const at = (x: number, y: number): Point => (relative ? [current[0] + x, current[1] + y] : [x, y]);
    const upper = command.toUpperCase();
    let control: Point | null = null;
    let quadControl: Point | null = null;

    switch (upper) {
      case "M":
        finish();
        current = start = at(scanner.number(), scanner.number());
        break;
      case "Z":
        if (segments.length) push({ kind: "line", from: current, to: start });
        finish();
        current = start;
        break;
      case "L": {
        const to = at(scanner.number(), scanner.number());
        push({ kind: "line", from: current, to });
        current = to;
        break;
      }
      case "H": {
        const x = scanner.number();
        const to: Point = [relative ? current[0] + x : x, current[1]];
        push({ kind: "line", from: current, to });
        current = to;
        break;
      }
      case "V": {
        const y = scanner.number();
        const to: Point = [current[0], relative ? current[1] + y : y];
        push({ kind: "line", from: current, to });
        current = to;
        break;
      }
      case "C": {
        const c1 = at(scanner.number(), scanner.number());
        const c2 = at(scanner.number(), scanner.number());
        const to = at(scanner.number(), scanner.number());
        push({ kind: "cubic", from: current, c1, c2, to });
        control = c2;
        current = to;
        break;
      }
      case "S": {
        const c1: Point = lastControl ? [2 * current[0] - lastControl[0], 2 * current[1] - lastControl[1]] : current;
        const c2 = at(scanner.number(), scanner.number());
        const to = at(scanner.number(), scanner.number());
        push({ kind: "cubic", from: current, c1, c2, to });
        control = c2;
        current = to;
        break;
      }
      case "Q":
      case "T": {
        const q: Point = upper === "Q"
          ? at(scanner.number(), scanner.number())
          : lastQuadControl ? [2 * current[0] - lastQuadControl[0], 2 * current[1] - lastQuadControl[1]] : current;
        const to = at(scanner.number(), scanner.number());
        push(quadToCubic(current, q, to));
        quadControl = q;
        current = to;
        break;
      }
      case "A": {
        const rx = scanner.number();
        const ry = scanner.number();
        const rotation = scanner.number();
        const largeArc = scanner.flag();
        const sweep = scanner.flag();
        const to = at(scanner.number(), scanner.number());
        for (const s of arcSegments(current, rx, ry, rotation, largeArc, sweep, to, m)) {
          if (s.from[0] !== s.to[0] || s.from[1] !== s.to[1]) segments.push(s);
        }
        current = to;
        break;
      }
      default:
        throw new SyntaxError(`unknown path command "${command}"`);
    }
    lastControl = control;
    lastQuadControl = quadControl;
  }
  finish();
  return contours;
}

function quadToCubic(from: Point, q: Point, to: Point): Segment {
  return {
    kind: "cubic",
    from,
    c1: [from[0] + (2 / 3) * (q[0] - from[0]), from[1] + (2 / 3) * (q[1] - from[1])],
    c2: [to[0] + (2 / 3) * (q[0] - to[0]), to[1] + (2 / 3) * (q[1] - to[1])],
    to,
  };
}

/**
 * Elliptical arc (SVG endpoint form) as transformed segments: an exact
 * three-point arc when it stays circular, otherwise cubic Beziers.
 */
export function arcSegments(
  from: Point, rx: number, ry: number, rotationDeg: number,
  largeArc: boolean, sweep: boolean, to: Point, m: Matrix,
): Segment[] {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [transformSegment(m, { kind: "line", from, to })];
  if (from[0] === to[0] && from[1] === to[1]) return [];

  // SVG spec F.6.5: endpoint to center parameterization.
  const phi = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from[0] - to[0]) / 2;
  const dy = (from[1] - to[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let factor = Math.sqrt(Math.max(0, numerator / denominator));
  if (largeArc === sweep) factor = -factor;
  const cxp = (factor * rx * y1) / ry;
  const cyp = (-factor * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (from[0] + to[0]) / 2;
  const cy = sin * cxp + cos * cyp + (from[1] + to[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  const point = (t: number): Point => {
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    return [cos * x - sin * y + cx, sin * x + cos * y + cy];
  };

  const circular = Math.abs(rx - ry) <= 1e-9 * Math.max(rx, ry) && isSimilarity(m);
  const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / pieces;
  const segments: Segment[] = [];
  for (let i = 0; i < pieces; i++) {
    const t0 = theta1 + i * step;
    const t1 = t0 + step;
    const p0 = i === 0 ? from : point(t0);
    const p1 = i === pieces - 1 ? to : point(t1);
    if (circular) {
      segments.push({ kind: "arc", from: apply(m, p0), via: apply(m, point((t0 + t1) / 2)), to: apply(m, p1) });
    } else {
      // Standard cubic approximation of an elliptical arc piece of at most 90°.
      const k = (4 / 3) * Math.tan(step / 4);
      const d0: Point = [-rx * Math.sin(t0), ry * Math.cos(t0)];
      const d1: Point = [-rx * Math.sin(t1), ry * Math.cos(t1)];
      const rotate = ([x, y]: Point): Point => [cos * x - sin * y, sin * x + cos * y];
      const r0 = rotate(d0);
      const r1 = rotate(d1);
      segments.push(transformSegment(m, {
        kind: "cubic",
        from: p0,
        c1: [p0[0] + k * r0[0], p0[1] + k * r0[1]],
        c2: [p1[0] - k * r1[0], p1[1] - k * r1[1]],
        to: p1,
      }));
    }
  }
  return segments;
}

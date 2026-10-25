import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseColor, toHex } from "../src/engine/svg/color";
import { flatten, polygonArea, type Contour } from "../src/engine/svg/geometry";
import { pathContours } from "../src/engine/svg/pathData";
import { parseSvg, parseTransform } from "../src/engine/svg/parseSvg";

const area = (c: Contour) => Math.abs(polygonArea(flatten(c, 256)));
const svg = (body: string, attrs = 'viewBox="0 0 100 100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`;

describe("path data", () => {
  it("parses implicit commands, relative moves and closes subpaths", () => {
    const contours = pathContours("m0 0 10 0 0 10 -10 0z M20 20 h5 v5 h-5", [1, 0, 0, 1, 0, 0]);
    expect(contours).toHaveLength(2);
    expect(area(contours[0])).toBeCloseTo(100);
    expect(area(contours[1])).toBeCloseTo(25);
  });

  it("reads compact arc flags and keeps circular arcs exact", () => {
    const [circle] = pathContours("M0 0a10 10 0 1020 0a10 10 0 10-20 0z", [1, 0, 0, 1, 0, 0]);
    expect(circle.kind === "path" && circle.segments.every((s) => s.kind === "arc")).toBe(true);
    expect(area(circle)).toBeCloseTo(Math.PI * 100, 1);
  });

  it("approximates elliptical arcs and non-uniform transforms with Beziers", () => {
    const [ellipse] = pathContours("M0 0A20 10 0 0 0 40 0A20 10 0 0 0 0 0z", [1, 0, 0, 1, 0, 0]);
    expect(ellipse.kind === "path" && ellipse.segments.every((s) => s.kind === "cubic")).toBe(true);
    expect(area(ellipse)).toBeCloseTo(Math.PI * 200, 0);
    const [stretched] = pathContours("M0 0a10 10 0 1 0 20 0a10 10 0 1 0 -20 0z", [2, 0, 0, 1, 0, 0]);
    expect(stretched.kind === "path" && stretched.segments.every((s) => s.kind === "cubic")).toBe(true);
  });

  it("converts quadratic and smooth curves", () => {
    const [c] = pathContours("M0 0Q10 10 20 0T40 0L40 -5L0 -5Z", [1, 0, 0, 1, 0, 0]);
    expect(c.kind === "path" && c.segments.filter((s) => s.kind === "cubic")).toHaveLength(2);
  });
});

describe("degenerate path data", () => {
  const ends = (c: Contour) => (c.kind === "path" ? c.segments.map((s) => [s.from, s.to]) : []);

  it("drops curves collapsed to a point and keeps the outline joined", () => {
    const [c] = pathContours("M0 0C0 0 0 0 0 0L10 0L10 10C10 10 10 10 10 10L0 10Z", [1, 0, 0, 1, 0, 0]);
    expect(ends(c)).toEqual([[[0, 0], [10, 0]], [[10, 0], [10, 10]], [[10, 10], [0, 10]], [[0, 10], [0, 0]]]);
  });

  it("closes onto the start instead of adding a hair-length closing line", () => {
    const [c] = pathContours("M0 0L10 0L10 10L0.00001 0", [1, 0, 0, 1, 0, 0]);
    expect(c.kind === "path" && c.segments).toHaveLength(3);
    expect(ends(c).at(-1)![1]).toEqual([0, 0]);
  });
});

describe("colors and transforms", () => {
  it("parses CSS colors", () => {
    expect(parseColor("#f00")).toEqual([1, 0, 0, 1]);
    expect(toHex(parseColor("rebeccapurple")!.slice(0, 3) as [number, number, number])).toBe("#663399");
    expect(parseColor("rgb(255, 0, 51)")?.[2]).toBeCloseTo(0.2);
    expect(parseColor("rgba(0 0 0 / 0)")?.[3]).toBe(0);
    expect(parseColor("hsl(120, 100%, 50%)")?.map((v) => Math.round(v * 255))).toEqual([0, 255, 0, 255]);
    expect(parseColor("none")).toBeNull();
  });

  it("composes transform lists left to right", () => {
    const m = parseTransform("translate(10 20) rotate(90) scale(2)");
    expect(m.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 2, -2, 0, 10, 20]);
  });
});

describe("documents", () => {
  it("scales the canvas so the longest side is the requested size", () => {
    const parsed = parseSvg(readFileSync(new URL("../../examples/test.svg", import.meta.url), "utf8"), 150);
    expect(parsed.width).toBeCloseTo(150);
    expect(parsed.height).toBeCloseTo(75);
    expect(parsed.shapes.map((s) => toHex(s.color))).toEqual(["#e63946", "#1d3557", "#2a9d8f", "#f4a261", "#f4a261"]);
  });

  it("flips Y so the top of the SVG is the top of the model", () => {
    const parsed = parseSvg(svg('<rect x="0" y="0" width="10" height="10"/>'), 100);
    const ys = flatten(parsed.shapes[0].contours[0]).map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(90);
    expect(Math.max(...ys)).toBeCloseTo(100);
  });

  it("resolves the fill cascade", () => {
    const parsed = parseSvg(svg(`
      <style>.a { fill: #00f } g > .b { fill: #0f0 } #c { fill: red }</style>
      <g fill="#123456"><rect width="1" height="1"/><rect class="b" width="1" height="1"/></g>
      <rect class="a" fill="#fff" width="1" height="1"/>
      <rect id="c" class="a" width="1" height="1"/>
      <rect class="a" style="fill: yellow" width="1" height="1"/>
      <g color="#abcdef"><rect fill="currentColor" width="1" height="1"/></g>`), 100);
    expect(parsed.shapes.map((s) => toHex(s.color))).toEqual(["#123456", "#00ff00", "#0000ff", "#ff0000", "#ffff00", "#abcdef"]);
  });

  it("skips unfilled, transparent and hidden shapes", () => {
    const parsed = parseSvg(svg(`
      <rect fill="none" width="1" height="1"/>
      <rect fill-opacity="0" width="1" height="1"/>
      <g opacity="0"><rect width="1" height="1"/></g>
      <g style="display:none"><rect width="1" height="1"/></g>
      <rect visibility="hidden" width="1" height="1"/>
      <line x1="0" y1="0" x2="10" y2="10" stroke="none"/>
      <defs><rect id="d" fill="#0f0" width="5" height="5"/></defs>
      <rect fill="#f00" width="1" height="1"/>`), 100);
    expect(parsed.shapes.map((s) => toHex(s.color))).toEqual(["#ff0000"]);
  });

  describe("strokes", () => {
    const area = (shape: { contours: Contour[] }) => shape.contours.reduce((sum, c) => sum + polygonArea(flatten(c)), 0);

    it("paints a stroke as an outline over its element's fill", () => {
      const parsed = parseSvg(svg('<rect x="10" y="10" width="20" height="20" fill="#f00" stroke="#00f" stroke-width="2"/>'), 100);
      expect(parsed.shapes.map((s) => [toHex(s.color), s.label])).toEqual([["#ff0000", "rect"], ["#0000ff", "rect stroke"]]);
      // A ring 2 wide, centered on the rectangle's edge, with mitered corners.
      expect(Math.abs(area(parsed.shapes[1]))).toBeCloseTo(22 * 22 - 18 * 18, 3);
    });

    it("leaves an open path open, with the requested caps", () => {
      const butt = parseSvg(svg('<path d="M10 50 H90" fill="none" stroke="#000" stroke-width="4"/>'), 100);
      expect(Math.abs(area(butt.shapes[0]))).toBeCloseTo(80 * 4, 3);
      const round = parseSvg(svg('<polyline points="10 50 90 50" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round"/>'), 100);
      expect(Math.abs(area(round.shapes[0]))).toBeCloseTo(80 * 4 + Math.PI * 4, 1);
    });

    it("scales stroke width with the transform and the canvas", () => {
      const parsed = parseSvg(svg('<g transform="scale(2)"><line x1="5" y1="25" x2="45" y2="25" stroke="#000"/></g>'), 200);
      // 80 user units long and 2 wide after the transform; the canvas doubles both.
      expect(Math.abs(area(parsed.shapes[0]))).toBeCloseTo(160 * 4, 2);
    });
  });

  it("follows use references and gradient fills", () => {
    const parsed = parseSvg(svg(`
      <defs>
        <linearGradient id="g"><stop offset="0" stop-color="#336699"/><stop offset="1" stop-color="#fff"/></linearGradient>
        <circle id="dot" r="5" fill="url(#g)"/>
      </defs>
      <use xlink:href="#dot" x="50" y="50"/>`), 100);
    expect(parsed.shapes).toHaveLength(1);
    expect(toHex(parsed.shapes[0].color)).toBe("#336699");
    const c = parsed.shapes[0].contours[0];
    expect(c.kind === "circle" && c.center).toEqual([50, 50]);
  });

  it("uses width and height when there is no viewBox", () => {
    const parsed = parseSvg(svg('<rect width="20" height="10"/>', 'width="40" height="20"'), 100);
    expect([parsed.width, parsed.height]).toEqual([100, 50]);
  });
});

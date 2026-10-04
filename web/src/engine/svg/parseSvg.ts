/**
 * Parse an SVG document into filled shapes, in paint order, mapped into
 * millimeters: Y up, canvas corner at the origin, longest side = size.
 *
 * Supported: path, rect (incl. rounded), circle, ellipse, polygon, polyline,
 * groups, nested svg, use, transforms, presentation attributes, inline style,
 * <style> rules (type, class, id, descendant and child selectors), inherited
 * fill, fill-rule, opacity, currentColor, display and visibility. Gradients use their
 * first stop color. Strokes, text, images, clipping and masks are ignored.
 */

import { DOMParser } from "@xmldom/xmldom";
import { parseColor, type RGB } from "./color";
import { IDENTITY, multiply, transformedEllipse, type Contour, type Matrix } from "./geometry";
import { pathContours } from "./pathData";

export type FillRule = "nonzero" | "evenodd";

export interface FilledShape {
  contours: Contour[];
  color: RGB;
  fillRule: FillRule;
  /** Element id, or tag name when it has none. */
  label: string;
}

export interface ParsedSvg {
  /** Canvas size in mm; the canvas spans [0, width] × [0, height]. */
  width: number;
  height: number;
  shapes: FilledShape[];
}

type Style = Record<string, string>;

const STYLE_PROPS = ["fill", "fill-opacity", "fill-rule", "opacity", "display", "visibility", "color", "stop-color"];
const INHERITED = new Set(["fill", "fill-opacity", "fill-rule", "visibility", "color"]);
const CONTAINERS = new Set(["svg", "g", "a", "switch"]);
const SKIPPED = new Set([
  "defs", "symbol", "clipPath", "mask", "pattern", "marker", "linearGradient", "radialGradient",
  "style", "title", "desc", "metadata", "text", "image", "foreignObject", "filter", "script",
]);

const UNITS: Record<string, number> = { "": 1, px: 1, mm: 96 / 25.4, cm: 960 / 25.4, in: 96, pt: 4 / 3, pc: 16 };

function length(value: string | null, fallback = 0): number {
  if (value == null || value.trim() === "") return fallback;
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(value);
  if (!match) return fallback;
  const unit = match[2].toLowerCase();
  return unit in UNITS ? Number(match[1]) * UNITS[unit] : fallback;
}

function numbers(value: string | null): number[] {
  return (value ?? "").match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g)?.map(Number) ?? [];
}

export function parseTransform(value: string | null): Matrix {
  let m = IDENTITY;
  for (const [, name, args] of (value ?? "").matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const n = numbers(args);
    let t: Matrix = IDENTITY;
    switch (name) {
      case "matrix":
        if (n.length === 6) t = [n[0], n[1], n[2], n[3], n[4], n[5]];
        break;
      case "translate":
        t = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0];
        break;
      case "scale":
        t = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const a = ((n[0] ?? 0) * Math.PI) / 180;
        const [cx, cy] = [n[1] ?? 0, n[2] ?? 0];
        const r: Matrix = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        t = multiply(multiply([1, 0, 0, 1, cx, cy], r), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case "skewX":
        t = [1, 0, Math.tan(((n[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        t = [1, Math.tan(((n[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = multiply(m, t);
  }
  return m;
}

function parseDeclarations(text: string): Style {
  const style: Style = {};
  for (const declaration of text.split(";")) {
    const i = declaration.indexOf(":");
    if (i > 0) {
      const name = declaration.slice(0, i).trim().toLowerCase();
      style[name] = declaration.slice(i + 1).replace(/!important/i, "").trim();
    }
  }
  return style;
}

/** A compound selector: optional tag, classes and id. */
interface Compound { tag?: string; id?: string; classes: string[] }
interface Rule { parts: Compound[]; combinators: string[]; specificity: number; order: number; style: Style }

function parseCompound(text: string): Compound | null {
  const compound: Compound = { classes: [] };
  for (const [token] of text.matchAll(/[.#]?[\w-]+|\*/g)) {
    if (token === "*") continue;
    if (token.startsWith(".")) compound.classes.push(token.slice(1));
    else if (token.startsWith("#")) compound.id = token.slice(1);
    else compound.tag = token;
  }
  return text.replace(/[.#]?[\w-]+|\*/g, "") === "" ? compound : null;
}

function parseStylesheet(css: string, firstOrder: number): Rule[] {
  const rules: Rule[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@[^{]+\{([^{}]*\{[^}]*\})*[^}]*\}/g, "");
  for (const [, selectors, body] of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const style = parseDeclarations(body);
    for (const selector of selectors.split(",")) {
      const tokens = selector.trim().replace(/\s*>\s*/g, " > ").split(/\s+/).filter(Boolean);
      const parts: Compound[] = [];
      const combinators: string[] = [];
      let valid = tokens.length > 0;
      for (const token of tokens) {
        if (token === ">") {
          combinators[parts.length - 1] = ">";
          continue;
        }
        const compound = parseCompound(token);
        if (!compound) valid = false;
        else {
          if (parts.length) combinators[parts.length - 1] ??= " ";
          parts.push(compound);
        }
      }
      if (!valid || !parts.length) continue;
      const specificity = parts.reduce(
        (s, p) => s + (p.id ? 10000 : 0) + p.classes.length * 100 + (p.tag ? 1 : 0), 0);
      rules.push({ parts, combinators, specificity, order: firstOrder + rules.length, style });
    }
  }
  return rules;
}

function matches(element: Element, c: Compound): boolean {
  if (c.tag && element.localName !== c.tag) return false;
  if (c.id && element.getAttribute("id") !== c.id) return false;
  const classes = (element.getAttribute("class") ?? "").split(/\s+/);
  return c.classes.every((name) => classes.includes(name));
}

function ruleMatches(rule: Rule, element: Element, ancestors: Element[]): boolean {
  if (!matches(element, rule.parts[rule.parts.length - 1])) return false;
  let i = ancestors.length - 1;
  for (let p = rule.parts.length - 2; p >= 0; p--) {
    const child = rule.combinators[p] === ">";
    let found = false;
    while (i >= 0) {
      const candidate = ancestors[i--];
      if (matches(candidate, rule.parts[p])) {
        found = true;
        break;
      }
      if (child) return false;
    }
    if (!found) return false;
  }
  return true;
}

function childElements(node: Element): Element[] {
  const children: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) children.push(child as Element);
  }
  return children;
}

function href(element: Element): string | null {
  const value = element.getAttribute("href") ?? element.getAttribute("xlink:href");
  return value?.startsWith("#") ? value.slice(1) : null;
}

export function parseSvg(text: string, size: number): ParsedSvg {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement as unknown as Element | null;
  if (!root || root.localName !== "svg") throw new Error("Not an SVG document");

  const byId = new Map<string, Element>();
  const rules: Rule[] = [];
  const index = (element: Element) => {
    const id = element.getAttribute("id");
    if (id && !byId.has(id)) byId.set(id, element);
    if (element.localName === "style") rules.push(...parseStylesheet(element.textContent ?? "", rules.length));
    childElements(element).forEach(index);
  };
  index(root);
  rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);

  const ownStyle = (element: Element, ancestors: Element[]): Style => {
    const style: Style = {};
    for (const prop of STYLE_PROPS) {
      const value = element.getAttribute(prop);
      if (value != null) style[prop] = value.trim();
    }
    for (const rule of rules) if (ruleMatches(rule, element, ancestors)) Object.assign(style, rule.style);
    Object.assign(style, parseDeclarations(element.getAttribute("style") ?? ""));
    return style;
  };

  const computed = (element: Element, ancestors: Element[], parent: Style): Style => {
    const own = ownStyle(element, ancestors);
    const style: Style = {};
    for (const prop of INHERITED) style[prop] = parent[prop];
    for (const [prop, value] of Object.entries(own)) {
      if (value !== "inherit") style[prop] = value;
    }
    const opacity = Number(own.opacity ?? 1);
    style.opacity = String((Number.isFinite(opacity) ? opacity : 1) * Number(parent.opacity ?? 1));
    return style;
  };

  const fillColor = (style: Style): RGB | null => {
    let value = (style.fill ?? "black").trim();
    const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(value);
    if (url) value = gradientColor(url[1]) ?? "none";
    if (value.toLowerCase() === "currentcolor") value = style.color ?? "black";
    const rgba = parseColor(value);
    if (!rgba) return null;
    const alpha = rgba[3] * Number(style["fill-opacity"] ?? 1) * Number(style.opacity ?? 1);
    return alpha > 0 ? [rgba[0], rgba[1], rgba[2]] : null;
  };

  const gradientColor = (id: string, depth = 0): string | null => {
    const gradient = byId.get(id);
    if (!gradient || depth > 8) return null;
    const stop = childElements(gradient).find((c) => c.localName === "stop");
    if (stop) {
      const own = ownStyle(stop, []);
      return own["stop-color"] ?? "black";
    }
    const next = href(gradient);
    return next ? gradientColor(next, depth + 1) : null;
  };

  // Root viewBox becomes the canvas; without one, the width and height do.
  const viewBox = numbers(root.getAttribute("viewBox"));
  let [vx, vy, vw, vh] = viewBox.length === 4 ? viewBox : [0, 0, length(root.getAttribute("width")), length(root.getAttribute("height"))];

  const shapes: FilledShape[] = [];
  const raw: { element: Element; m: Matrix; color: RGB; fillRule: FillRule }[] = [];

  const walk = (element: Element, m: Matrix, ancestors: Element[], parent: Style, viaUse = 0) => {
    const tag = element.localName;
    if (SKIPPED.has(tag) && !(viaUse && tag === "symbol")) return;
    const style = computed(element, ancestors, parent);
    if (style.display === "none") return;
    let local = multiply(m, parseTransform(element.getAttribute("transform")));
    const lineage = [...ancestors, element];

    if (tag === "use") {
      const target = href(element);
      const referenced = target ? byId.get(target) : undefined;
      if (referenced && viaUse < 16 && !lineage.includes(referenced)) {
        local = multiply(local, [1, 0, 0, 1, length(element.getAttribute("x")), length(element.getAttribute("y"))]);
        walk(referenced, local, lineage, style, viaUse + 1);
      }
      return;
    }
    if (CONTAINERS.has(tag) || tag === "symbol") {
      if (tag === "svg" && element !== root) {
        local = multiply(local, [1, 0, 0, 1, length(element.getAttribute("x")), length(element.getAttribute("y"))]);
      }
      for (const child of childElements(element)) walk(child, local, lineage, style, viaUse);
      return;
    }
    if (style.visibility === "hidden" || style.visibility === "collapse") return;
    const color = fillColor(style);
    const fillRule = style["fill-rule"] === "evenodd" ? "evenodd" : "nonzero";
    if (color) raw.push({ element, m: local, color, fillRule });
  };
  walk(root, IDENTITY, [], { opacity: "1" });

  if (!(vw > 0 && vh > 0)) {
    // No usable canvas size: fall back to the content's bounds.
    const all = raw.flatMap(({ element, m }) => elementContours(element, m));
    const points = all.flatMap(contourExtents);
    if (!points.length) throw new Error("The SVG has no size and no filled shapes");
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    [vx, vy, vw, vh] = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  }

  const scale = size / Math.max(vw, vh);
  // SVG is Y-down; flip so the model is Y-up with the canvas corner at the origin.
  const toMillimeters: Matrix = [scale, 0, 0, -scale, -vx * scale, (vy + vh) * scale];
  for (const { element, m, color, fillRule } of raw) {
    const contours = elementContours(element, multiply(toMillimeters, m));
    if (contours.length) shapes.push({ contours, color, fillRule, label: element.getAttribute("id") ?? element.localName });
  }
  return { width: vw * scale, height: vh * scale, shapes };
}

function elementContours(element: Element, m: Matrix): Contour[] {
  const attr = (name: string) => element.getAttribute(name);
  switch (element.localName) {
    case "path":
      return pathContours(attr("d") ?? "", m);
    case "rect": {
      const x = length(attr("x"));
      const y = length(attr("y"));
      const w = length(attr("width"));
      const h = length(attr("height"));
      if (!(w > 0 && h > 0)) return [];
      let rx = length(attr("rx"), NaN);
      let ry = length(attr("ry"), NaN);
      if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
      if (Number.isNaN(ry)) ry = rx;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);
      const d = rx > 0 && ry > 0
        ? `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}` +
          `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
          `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
        : `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return pathContours(d, m);
    }
    case "circle": {
      const r = length(attr("r"));
      return r > 0 ? [transformedEllipse(m, length(attr("cx")), length(attr("cy")), r, r)] : [];
    }
    case "ellipse": {
      let rx = length(attr("rx"), NaN);
      let ry = length(attr("ry"), NaN);
      if (Number.isNaN(rx)) rx = ry;
      if (Number.isNaN(ry)) ry = rx;
      return rx > 0 && ry > 0 ? [transformedEllipse(m, length(attr("cx")), length(attr("cy")), rx, ry)] : [];
    }
    case "polygon":
    case "polyline": {
      const n = numbers(attr("points"));
      if (n.length < 6) return [];
      const pairs = Array.from({ length: Math.floor(n.length / 2) }, (_, i) => `${n[2 * i]} ${n[2 * i + 1]}`);
      return pathContours(`M${pairs.join("L")}Z`, m);
    }
    default:
      return [];
  }
}

function contourExtents(contour: Contour): [number, number][] {
  if (contour.kind === "path") return contour.segments.flatMap((s) => [[...s.from], [...s.to]] as [number, number][]);
  const r = contour.kind === "circle" ? contour.radius : Math.max(contour.rx, contour.ry);
  const [x, y] = contour.center;
  return [[x - r, y - r], [x + r, y + r]];
}

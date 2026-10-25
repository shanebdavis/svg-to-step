/**
 * Fewer colors without dithering: repeatedly merge the two colors that look
 * most alike until only the target count remains. Similarity is distance in
 * OKLab, a perceptually uniform color space; a merged color is the
 * area-weighted mean of its members there.
 */

import type { RGB } from "./svg/color";

type Lab = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (c: number) => Math.min(1, Math.max(0, c));

export function toOklab(rgb: RGB): Lab {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function fromOklab([L, a, b]: Lab): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => clamp(toGamma(c))) as unknown as RGB;
}

const distance = (p: Lab, q: Lab) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/** For each input color, the color it becomes once at most `count` remain. */
export function reduceColors(colors: { color: RGB; area: number }[], count: number): RGB[] {
  // Zero-area colors still need a weight to average with.
  const clusters = colors.map(({ color, area }, i) => ({ lab: toOklab(color), area: Math.max(area, 1e-9), members: [i] }));
  while (clusters.length > Math.max(1, count)) {
    let best = { d: Infinity, i: 0, j: 1 };
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = distance(clusters[i].lab, clusters[j].lab);
        if (d < best.d) best = { d, i, j };
      }
    }
    const [p, q] = [clusters[best.i], clusters[best.j]];
    const area = p.area + q.area;
    p.lab = p.lab.map((v, k) => (v * p.area + q.lab[k] * q.area) / area) as Lab;
    p.area = area;
    p.members.push(...q.members);
    clusters.splice(best.j, 1);
  }
  const result: RGB[] = colors.map((c) => c.color);
  for (const cluster of clusters) {
    if (cluster.members.length === 1) continue;
    const merged = fromOklab(cluster.lab);
    for (const i of cluster.members) result[i] = merged;
  }
  return result;
}

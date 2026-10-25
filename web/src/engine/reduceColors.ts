/**
 * Fewer colors without dithering or new colors: repeatedly merge the two
 * colors that look most alike until only the target count remains, the one
 * with less area taking the other's color. Similarity is distance in OKLab, a
 * perceptually uniform color space.
 */

import type { RGB } from "./svg/color";

type Lab = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function toOklab(rgb: RGB): Lab {
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

const distance = (p: Lab, q: Lab) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/** For each input color, the color it becomes once at most `count` remain. */
export function reduceColors(colors: { color: RGB; area: number }[], count: number): RGB[] {
  const clusters = colors.map(({ color, area }, i) => ({ color, lab: toOklab(color), area, members: [i] }));
  while (clusters.length > Math.max(1, count)) {
    let best = { d: Infinity, i: 0, j: 1 };
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = distance(clusters[i].lab, clusters[j].lab);
        if (d < best.d) best = { d, i, j };
      }
    }
    const [p, q] = [clusters[best.i], clusters[best.j]];
    const [keep, lose] = q.area > p.area ? [q, p] : [p, q];
    keep.area += lose.area;
    keep.members.push(...lose.members);
    clusters.splice(clusters.indexOf(lose), 1);
  }
  const result: RGB[] = colors.map((c) => c.color);
  for (const cluster of clusters) for (const i of cluster.members) result[i] = cluster.color;
  return result;
}

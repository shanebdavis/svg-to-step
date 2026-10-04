/** STEP output: schema, names and exact sRGB colors. Volumes are checked by re-import in Python. */

import { readFileSync } from "node:fs";
import opencascade from "replicad-opencascadejs";
import { beforeAll, expect, it } from "vitest";
import { build, DEFAULT_OPTIONS } from "../src/engine/build";
import { exportStep, setOC } from "../src/engine/occt/kernel";

beforeAll(async () => {
  setOC(await opencascade({ print: () => {}, printErr: () => {} }));
});

it("writes AP214 with every part named and colored exactly", () => {
  const svg = readFileSync(new URL("../../examples/test.svg", import.meta.url), "utf8");
  const model = build(svg, DEFAULT_OPTIONS);
  const step = new TextDecoder().decode(exportStep(model.parts.map((p) => ({ shape: p.solid, name: p.label, color: p.color }))));
  expect(step).toContain("AUTOMOTIVE_DESIGN");
  for (const part of model.parts) expect(step).toContain(`'${part.label}'`);
  const written = [...step.matchAll(/COLOUR_RGB\('[^']*',([^,]+),([^,]+),([^)]+)\)/g)].map((m) => m.slice(1, 4).map(Number));
  const expected = new Set(model.parts.map((p) => p.color.join()));
  for (const color of expected) {
    const rgb = color.split(",").map(Number);
    expect(written.some((w) => w.every((v, i) => Math.abs(v - rgb[i]) < 1e-6)), `color ${color}`).toBe(true);
  }
});

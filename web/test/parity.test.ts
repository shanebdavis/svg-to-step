/** The TypeScript engine against recorded svg2step.py results (see make_reference.py). */

import { existsSync, readFileSync } from "node:fs";
import opencascade from "replicad-opencascadejs";
import { beforeAll, describe, expect, it } from "vitest";
import { build, DEFAULT_OPTIONS, type Model } from "../src/engine/build";
import { boundingBox, isValid, setOC, volume } from "../src/engine/occt/kernel";
import { toHex } from "../src/engine/svg/color";

interface Case { mode: "puzzle" | "layers"; order?: "large" | "small"; slab: boolean; layerThickness?: number }
interface Summary { solids: number; volume: number; groups: Record<string, number>; volumes: number[]; size: number[] }
interface Reference { size: number; height: number; results: Record<string, (Summary & { case: Case })[]> }

const reference: Reference = JSON.parse(readFileSync(new URL("reference.json", import.meta.url), "utf8"));

beforeAll(async () => {
  setOC(await opencascade({ print: () => {}, printErr: () => {} }));
});

function summarize(model: Model): Summary & { valid: boolean } {
  const groups: Record<string, number> = {};
  const volumes = model.parts.map((p) => volume(p.solid));
  model.parts.forEach((p, i) => {
    const key = `${toHex(p.color)}@${p.level}`;
    groups[key] = (groups[key] ?? 0) + volumes[i];
  });
  const boxes = model.parts.map((p) => boundingBox(p.solid));
  const extent = (k: "X" | "Y" | "Z") =>
    Math.max(...boxes.map((b) => b[`max${k}`])) - Math.min(...boxes.map((b) => b[`min${k}`]));
  return {
    solids: model.parts.length,
    volume: volumes.reduce((a, b) => a + b, 0),
    groups,
    volumes: [...volumes].sort((a, b) => a - b),
    size: [extent("X"), extent("Y"), extent("Z")],
    valid: model.parts.every((p) => isValid(p.solid)),
  };
}

const close = (actual: number, expected: number, relative = 1e-4) =>
  Math.abs(actual - expected) <= relative * Math.max(1, Math.abs(expected));

for (const [file, results] of Object.entries(reference.results)) {
  const path = new URL(`../../examples/${file}`, import.meta.url);
  describe.skipIf(!existsSync(path))(file, () => {
    for (const expected of results) {
      const { mode, order = "large", slab, layerThickness = null } = expected.case;
      it(`${mode} ${mode === "layers" ? order : ""} slab=${slab} layer=${layerThickness ?? "auto"}`, () => {
        const model = build(readFileSync(path, "utf8"), {
          ...DEFAULT_OPTIONS,
          size: reference.size,
          height: reference.height,
          slabColor: slab ? DEFAULT_OPTIONS.slabColor : null,
          mode, order, layerThickness,
        });
        const actual = summarize(model);
        expect(actual.valid).toBe(true);
        expect(actual.solids).toBe(expected.solids);
        expect(close(actual.volume, expected.volume), `volume ${actual.volume} vs ${expected.volume}`).toBe(true);
        expect(Object.keys(actual.groups).sort()).toEqual(Object.keys(expected.groups).sort());
        for (const [key, v] of Object.entries(expected.groups)) {
          expect(close(actual.groups[key], v), `${key}: ${actual.groups[key]} vs ${v}`).toBe(true);
        }
        actual.volumes.forEach((v, i) => {
          expect(close(v, expected.volumes[i], 1e-3), `piece ${i}: ${v} vs ${expected.volumes[i]}`).toBe(true);
        });
        actual.size.forEach((v, i) => expect(v).toBeCloseTo(expected.size[i], 3));
      });
    }
  });
}

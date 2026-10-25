/** 3MF output: a part per color, each assigned a filament and closed. Bambu Studio loads it as is. */

import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import opencascade from "replicad-opencascadejs";
import { beforeAll, expect, it } from "vitest";
import { build, DEFAULT_OPTIONS } from "../src/engine/build";
import { mesh, setOC } from "../src/engine/occt/kernel";
import { toHex } from "../src/engine/svg/color";
import { export3mf } from "../src/engine/threemf";

beforeAll(async () => {
  setOC(await opencascade({ print: () => {}, printErr: () => {} }));
});

it("writes one closed, colored part per color with its own filament", () => {
  const svg = readFileSync(new URL("../../examples/test.svg", import.meta.url), "utf8");
  const model = build(svg, { ...DEFAULT_OPTIONS, slabShape: "hexagon" });
  const meshes = model.parts.map((p) => ({ label: p.label, color: toHex(p.color), level: p.level, ...mesh(p.solid, 0.05, 0.3) }));
  const files = unzipSync(export3mf(meshes, "test"));
  const colors = [...new Set(meshes.map((m) => m.color))];

  const objects = strFromU8(files["3D/Objects/object_1.model"]);
  const groups = [...objects.matchAll(/<m:colorgroup id="(\d+)"><m:color color="(#\w{6})FF"\/>/g)];
  expect(groups.map((g) => g[2].toLowerCase())).toEqual(colors);
  const bodies = objects.split("<object ").slice(1);
  expect(bodies).toHaveLength(colors.length);
  bodies.forEach((body, i) => {
    expect(body).toContain(`pid="${groups[i][1]}" pindex="0"`);
    // Closed and consistently oriented: every directed edge has exactly one reverse twin.
    const edges = new Map<string, number>();
    for (const [, a, b, c] of body.matchAll(/v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) {
      for (const [u, v] of [[a, b], [b, c], [c, a]]) edges.set(`${u}>${v}`, (edges.get(`${u}>${v}`) ?? 0) + 1);
    }
    for (const [edge, count] of edges) {
      const [u, v] = edge.split(">");
      expect(count, edge).toBe(1);
      expect(edges.get(`${v}>${u}`), edge).toBe(1);
    }
  });

  const settings = strFromU8(files["Metadata/model_settings.config"]);
  colors.forEach((color, i) => {
    expect(settings).toMatch(new RegExp(`<part id="${i + 1}"[^>]*>\\s*<metadata key="name" value="${color}"/>[\\s\\S]*?<metadata key="extruder" value="${i + 1}"/>`));
  });
  // Either would make Bambu Studio treat the file as its own project and ignore the color groups.
  for (const model of [objects, strFromU8(files["3D/3dmodel.model"])]) {
    expect(model).not.toContain("Application");
    expect(model).not.toContain("BambuStudio:3mfVersion");
  }
});

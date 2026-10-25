/**
 * 3MF in Bambu Studio's layout: one object with a part per color, each part
 * assigned its own filament. Colors are standard 3MF color groups, which
 * Bambu Studio offers to map onto filaments.
 *
 * Bambu Studio reads standard colors only from files it doesn't consider
 * its own, so no Application or BambuStudio:3mfVersion metadata. A Bambu
 * project would also have to carry a full printer and filament profile.
 */

import { strToU8, zipSync } from "fflate";
import type { PartMesh } from "./protocol";

const CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const PRODUCTION = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";
const MATERIAL = "http://schemas.microsoft.com/3dmanufacturing/material/2015/02";
const MODEL_REL = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
const OBJECTS = "/3D/Objects/object_1.model";
/** Plate center of Bambu's 256 mm printers; smaller beds re-center on arrange. */
const PLATE_CENTER = 128;

const escape = (s: string) => s.replace(/[<>&"]/g, (c) => `&${{ "<": "lt", ">": "gt", "&": "amp", '"': "quot" }[c]};`);
const num = (v: number) => String(Math.round(v * 1e5) / 1e5);

const modelHeader = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${CORE}" xmlns:p="${PRODUCTION}" xmlns:m="${MATERIAL}" requiredextensions="p">`;

const relationships = (targets: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${targets.map((t, i) => ` <Relationship Target="${t}" Id="rel-${i + 1}" Type="${MODEL_REL}"/>`).join("\n")}
</Relationships>`;

interface Body { color: string; vertices: number[]; triangles: number[] }

/**
 * One body per color. Each face of an OpenCascade mesh has its own vertices;
 * welding coincident ones within a part makes each solid a closed shell.
 */
function bodiesByColor(meshes: PartMesh[], offset: [number, number, number]): Body[] {
  const bodies = new Map<string, Body>();
  for (const part of meshes) {
    const body = bodies.get(part.color) ?? { color: part.color, vertices: [], triangles: [] };
    bodies.set(part.color, body);
    const welded = new Map<string, number>();
    const index = Array.from({ length: part.positions.length / 3 }, (_, i) => {
      const p = [0, 1, 2].map((k) => part.positions[3 * i + k] - offset[k]);
      const key = p.map((v) => Math.round(v * 1e4)).join();
      let id = welded.get(key);
      if (id === undefined) {
        id = body.vertices.length / 3;
        welded.set(key, id);
        body.vertices.push(...p);
      }
      return id;
    });
    for (let t = 0; t < part.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => index[part.indices[t + k]]);
      if (a !== b && b !== c && a !== c) body.triangles.push(a, b, c);
    }
  }
  return [...bodies.values()];
}

function bounds(meshes: PartMesh[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { positions } of meshes) {
    for (let i = 0; i < positions.length; i++) {
      min[i % 3] = Math.min(min[i % 3], positions[i]);
      max[i % 3] = Math.max(max[i % 3], positions[i]);
    }
  }
  return { min, max };
}

export function export3mf(meshes: PartMesh[], name: string): Uint8Array {
  const { min, max } = bounds(meshes);
  // Bambu keeps an object's origin at its bounding-box center.
  const center: [number, number, number] = [0, 1, 2].map((k) => (min[k] + max[k]) / 2) as [number, number, number];
  const bodies = bodiesByColor(meshes, center);
  const assembly = bodies.length + 1;
  const colorGroup = (i: number) => assembly + 1 + i;
  const uuid = () => crypto.randomUUID();

  const objects = `${modelHeader}
 <resources>
${bodies.map((body, i) => `  <m:colorgroup id="${colorGroup(i)}"><m:color color="${body.color.toUpperCase()}FF"/></m:colorgroup>`).join("\n")}
${bodies.map((body, i) => `  <object id="${i + 1}" pid="${colorGroup(i)}" pindex="0" p:UUID="${uuid()}" type="model">
   <mesh>
    <vertices>
${Array.from({ length: body.vertices.length / 3 }, (_, v) =>
    `     <vertex x="${num(body.vertices[3 * v])}" y="${num(body.vertices[3 * v + 1])}" z="${num(body.vertices[3 * v + 2])}"/>`).join("\n")}
    </vertices>
    <triangles>
${Array.from({ length: body.triangles.length / 3 }, (_, t) =>
    `     <triangle v1="${body.triangles[3 * t]}" v2="${body.triangles[3 * t + 1]}" v3="${body.triangles[3 * t + 2]}"/>`).join("\n")}
    </triangles>
   </mesh>
  </object>`).join("\n")}
 </resources>
 <build/>
</model>`;

  const identity = "1 0 0 0 1 0 0 0 1 0 0 0";
  const model = `${modelHeader}
 <resources>
  <object id="${assembly}" p:UUID="${uuid()}" type="model">
   <components>
${bodies.map((_, i) => `    <component p:path="${OBJECTS}" objectid="${i + 1}" p:UUID="${uuid()}" transform="${identity}"/>`).join("\n")}
   </components>
  </object>
 </resources>
 <build p:UUID="${uuid()}">
  <item objectid="${assembly}" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 ${PLATE_CENTER} ${PLATE_CENTER} ${num(center[2] - min[2])}" printable="1"/>
 </build>
</model>`;

  const settings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${assembly}">
    <metadata key="name" value="${escape(name)}"/>
    <metadata key="extruder" value="1"/>
${bodies.map((body, i) => `    <part id="${i + 1}" subtype="normal_part">
      <metadata key="name" value="${body.color}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="extruder" value="${i + 1}"/>
    </part>`).join("\n")}
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <model_instance>
      <metadata key="object_id" value="${assembly}"/>
      <metadata key="instance_id" value="0"/>
    </model_instance>
  </plate>
</config>`;

  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`),
    "_rels/.rels": strToU8(relationships(["/3D/3dmodel.model"])),
    "3D/3dmodel.model": strToU8(model),
    "3D/_rels/3dmodel.model.rels": strToU8(relationships([OBJECTS])),
    "3D/Objects/object_1.model": strToU8(objects),
    "Metadata/model_settings.config": strToU8(settings),
  });
}

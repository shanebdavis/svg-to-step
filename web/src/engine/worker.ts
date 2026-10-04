/// <reference lib="webworker" />
/** Runs one build: load OpenCascade, build, mesh, export STEP, reply, done. */

import opencascade from "replicad-opencascadejs";
import { build } from "./build";
import { boundingBox, exportStep, mesh, setOC } from "./occt/kernel";
import type { BuildRequest, BuildResult, WorkerMessage } from "./protocol";
import { toHex } from "./svg/color";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async ({ data }: MessageEvent<BuildRequest>) => {
  const started = performance.now();
  try {
    setOC(await opencascade({
      print: () => {},
      printErr: () => {},
      instantiateWasm: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) => {
        WebAssembly.instantiate(data.wasm, imports).then(receive);
        return {};
      },
    }));
    const model = build(data.svg, data.options);
    const meshes = model.parts.map((part) => ({
      label: part.label,
      color: toHex(part.color),
      level: part.level,
      ...mesh(part.solid, 0.05, 0.3),
    }));
    const step = exportStep(model.parts.map((p) => ({ shape: p.solid, name: p.label, color: p.color })));
    const boxes = model.parts.map((p) => boundingBox(p.solid));
    const extent = (k: "X" | "Y" | "Z") => boxes.length
      ? Math.max(...boxes.map((b) => b[`max${k}`])) - Math.min(...boxes.map((b) => b[`min${k}`]))
      : 0;
    const result: BuildResult = {
      meshes,
      step,
      stats: {
        solids: model.parts.length,
        colors: model.colors,
        size: [extent("X"), extent("Y"), extent("Z")],
        seconds: (performance.now() - started) / 1000,
      },
    };
    const transfer = [step.buffer, ...meshes.flatMap((m) => [m.positions.buffer, m.indices.buffer])];
    self.postMessage({ ok: true, result } satisfies WorkerMessage, transfer as Transferable[]);
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WorkerMessage);
  }
};

/** UI side of the geometry worker: one worker per build, newest build wins. */

import wasmUrl from "replicad-opencascadejs/wasm?url";
import type { BuildOptions } from "./build";
import type { BuildRequest, BuildResult, WorkerMessage } from "./protocol";

let compiled: Promise<WebAssembly.Module> | null = null;
let running: { worker: Worker; reject: (reason: Error) => void } | null = null;
let generation = 0;

/** Compile OpenCascade once; each worker instantiates the compiled module. */
export function loadEngine(): Promise<WebAssembly.Module> {
  compiled ??= WebAssembly.compileStreaming(fetch(wasmUrl)).catch((error) => {
    compiled = null;
    throw error;
  });
  return compiled;
}

export class Superseded extends Error {}

export async function buildModel(svg: string, options: BuildOptions): Promise<BuildResult> {
  const mine = ++generation;
  running?.worker.terminate();
  running?.reject(new Superseded("superseded"));
  running = null;
  const wasm = await loadEngine();
  if (mine !== generation) throw new Superseded("superseded");
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const current = { worker, reject };
    running = current;
    const finish = () => {
      worker.terminate();
      if (running === current) running = null;
    };
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      finish();
      if (data.ok) resolve(data.result);
      else reject(new Error(data.error));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The geometry worker crashed"));
    };
    worker.postMessage({ wasm, svg, options } satisfies BuildRequest);
  });
}

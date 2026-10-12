/** Messages between the UI and the geometry worker. */

import type { BuildOptions } from "./build";

export interface BuildRequest {
  wasm: WebAssembly.Module;
  svg: string;
  options: BuildOptions;
}

export interface PartMesh {
  label: string;
  color: string;
  level: number;
  positions: Float32Array;
  indices: Uint32Array;
}

export interface BuildResult {
  meshes: PartMesh[];
  /** Hex colors of the SVG, largest visible area first. */
  palette: string[];
  step: Uint8Array;
  stats: { solids: number; colors: number; size: [number, number, number]; seconds: number };
}

export type WorkerMessage = { ok: true; result: BuildResult } | { ok: false; error: string };

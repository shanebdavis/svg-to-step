/** Messages between the UI and the geometry worker. */

import type { BuildOptions } from "./build";
import type { FillRule } from "./occt/kernel";

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
  /** Distinct visible colors in the SVG, before any color limit. */
  svgColors: number;
  /** What the 2D editor draws: SVG path data in model mm, Y up. */
  editor: {
    width: number;
    height: number;
    shapes: { color: string; fillRule: FillRule; d: string }[];
    /** Indices of the shapes left out. */
    deleted: number[];
    changes: { mode: "merge" | "thicken"; d: string }[];
    /** Model mm per stroke unit: strokes are stored before the fit to size. */
    fit: number;
  };
  stats: { solids: number; colors: number; size: [number, number, number]; seconds: number };
}

export type WorkerMessage = { ok: true; result: BuildResult } | { ok: false; error: string };

import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { Editor, pickedShapes, strokesOf, TOOL_COLORS, type Edit, type Tool } from "./Editor";
import { DEFAULT_OPTIONS, type BuildOptions } from "./engine/build";
import { buildModel, loadEngine, Superseded } from "./engine/client";
import type { BuildResult } from "./engine/protocol";
import { export3mf } from "./engine/threemf";
import { parseColor, type RGB } from "./engine/svg/color";
import { useStoredState } from "./useStoredState";
import { Viewer } from "./Viewer";

const DEFAULT_SETTINGS = {
  mode: "puzzle" as BuildOptions["mode"],
  order: "large" as BuildOptions["order"],
  layerThickness: "",
  size: 100,
  height: 5,
  slab: true,
  slabShape: "canvas" as BuildOptions["slabShape"],
  slabPadding: 5,
  base: false,
  baseThickness: 2,
  explode: 0,
  minFeature: 0,
  featureMode: "merge" as BuildOptions["featureMode"],
  view: "3d" as "3d" | "2d",
  tool: "merge" as Tool,
  brushRadius: 1,
};

const TOOLS: { tool: Tool; label: string; title: string }[] = [
  { tool: "delete", label: "Delete", title: "Deletes every shape the paint covers completely" },
  { tool: "pick", label: "Pick", title: "Click a shape to delete it, again to restore it" },
  { tool: "merge", label: "Merge", title: "Too-thin parts here merge into their neighbors" },
  { tool: "thicken", label: "Thicken", title: "Too-thin parts here grow to the minimum width" },
  { tool: "keep", label: "Keep", title: "Too-thin parts here stay as they are" },
  { tool: "erase", label: "Erase", title: "Removes paint" },
];

type Settings = typeof DEFAULT_SETTINGS;
type Status = { kind: "idle" | "working" | "ready" | "error"; message: string };

const toRgb = (hex: string): RGB | null => {
  const rgba = parseColor(hex);
  return rgba && [rgba[0], rgba[1], rgba[2]];
};

/**
 * color is the slab and base color, from the SVG's palette, or null for the color with the most area.
 * maxColors limits the SVG's colors, or null keeps them all.
 */
function toOptions(s: Settings, color: string | null, maxColors: number | null, edits: Edit[]): BuildOptions | null {
  const layerThickness = s.layerThickness.trim() === "" ? null : Number(s.layerThickness);
  const baseThickness = s.mode === "puzzle" && s.base ? s.baseThickness : null;
  const positive = [s.size, s.height, layerThickness ?? 1, baseThickness ?? 1];
  if (!positive.every((v) => v > 0) || !(s.slabPadding >= 0) || !(s.minFeature >= 0)) return null;
  return {
    ...DEFAULT_OPTIONS,
    mode: s.mode,
    order: s.order,
    size: s.size,
    height: s.height,
    layerThickness,
    slabColor: s.slab ? (color ? toRgb(color) : null) ?? "auto" : null,
    slabShape: s.slabShape,
    slabPadding: s.slabPadding,
    baseThickness,
    baseColor: color ? toRgb(color) : null,
    maxColors,
    minFeature: s.minFeature,
    featureMode: s.featureMode,
    strokes: strokesOf(edits),
    deletedShapes: pickedShapes(edits),
  };
}

export function App() {
  const [settings, setSettings] = useStoredState("svg2step.settings", DEFAULT_SETTINGS);
  const [{ file, chosenBase, colorLimit, edits }, setDocument] = useStoredState("svg2step.document", {
    file: null as { name: string; text: string } | null,
    chosenBase: null as string | null,
    colorLimit: null as number | null,
    edits: [] as Edit[],
  });
  const addEdit = (edit: Edit) => setDocument((d) => ({ ...d, edits: [...d.edits, edit] }));
  const undo = () => setDocument((d) => ({ ...d, edits: d.edits.slice(0, -1) }));
  const setChosenBase = (base: string | null) => setDocument((d) => ({ ...d, chosenBase: base }));
  const setColorLimit = (limit: number | null) => setDocument((d) => ({ ...d, colorLimit: limit }));
  const [result, setResult] = useState<BuildResult | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle", message: "Loading CAD engine…" });
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((s) => ({ ...s, [key]: value }));

  useEffect(() => {
    loadEngine().then(
      () => setStatus((s) => (s.kind === "idle" ? { kind: "idle", message: "" } : s)),
      (error) => setStatus({ kind: "error", message: `Could not load the CAD engine: ${error.message}` }),
    );
  }, []);

  const { explode, ...buildSettings } = settings;
  const options = toOptions(settings, chosenBase, colorLimit, edits);
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    if (!file) return;
    if (!options) {
      setStatus({ kind: "error", message: "Size, height and thicknesses must be positive numbers; padding and min feature zero or more." });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setStatus({ kind: "working", message: "Converting…" });
      buildModel(file.text, options).then(
        (built) => {
          if (cancelled) return;
          setResult(built);
          const { solids, colors, size, seconds } = built.stats;
          const fixed = built.editor.changes.length;
          setStatus({
            kind: "ready",
            message: `${solids} solids, ${colors} colors\n${size.map((v) => v.toFixed(2)).join(" × ")} mm\n`
              + (fixed ? `${fixed} thin part${fixed === 1 ? "" : "s"} fixed\n` : "")
              + `built in ${seconds.toFixed(1)} s`,
          });
        },
        (error) => {
          if (!cancelled && !(error instanceof Superseded)) setStatus({ kind: "error", message: error.message });
        },
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // optionsKey captures every build input; options itself is a fresh object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, optionsKey]);

  useEffect(() => {
    if (settings.view !== "2d") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        undo();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.view]);

  // A color limit can merge away the chosen color.
  useEffect(() => {
    if (result && chosenBase && !result.palette.includes(chosenBase)) setChosenBase(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const openFile = useCallback(async (picked: File | undefined) => {
    if (!picked) return;
    const text = await picked.text();
    setDocument({ file: { name: picked.name, text }, chosenBase: null, colorLimit: null, edits: [] });
    setResult(null);
  }, [setDocument]);

  const baseName = file?.name.replace(/\.svg$/i, "") ?? "model";
  const download = (bytes: Uint8Array, extension: string, type: string) => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${baseName}.${extension}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    openFile(event.dataTransfer.files[0]);
  };
  const dragProps = {
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop,
  };

  const layers = buildSettings.mode === "layers";
  const base = !layers && settings.base;
  const palette = result?.palette ?? [];
  const selectedBase = chosenBase ?? palette[0];
  return (
    <div className="app">
      <aside>
        <h1>SVG to STEP</h1>
        <button type="button" className={`drop ${dragging ? "over" : ""}`} onClick={() => input.current?.click()} {...dragProps}>
          Drop an SVG here<br />or click to choose
          {file && <strong>{file.name}</strong>}
        </button>
        <input ref={input} type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => openFile(e.target.files?.[0])} />

        {result && result.svgColors > 2 && (
          <label>
            Colors<span>{colorLimit ?? result.svgColors} of {result.svgColors}; merges the most alike first</span>
            <input type="range" min="2" max={result.svgColors} step="1" value={colorLimit ?? result.svgColors}
              onChange={(e) => setColorLimit(e.target.valueAsNumber >= result.svgColors ? null : e.target.valueAsNumber)} />
          </label>
        )}
        <div className="row">
          <label>
            Min feature<span>mm; 0 is off</span>
            <input type="number" min="0" step="0.1" value={settings.minFeature}
              onChange={(e) => update("minFeature", e.target.valueAsNumber)} />
          </label>
          <label>
            Thin parts<span>unless painted</span>
            <select value={settings.featureMode} disabled={!(settings.minFeature > 0)}
              onChange={(e) => update("featureMode", e.target.value as Settings["featureMode"])}>
              <option value="merge">Merge</option>
              <option value="thicken">Thicken</option>
              <option value="keep">Keep</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label>
            Mode
            <select value={settings.mode} onChange={(e) => update("mode", e.target.value as Settings["mode"])}>
              <option value="puzzle">Puzzle</option>
              <option value="layers">Layers</option>
            </select>
          </label>
          <label>
            Bottom layer
            <select value={settings.order} disabled={!layers} onChange={(e) => update("order", e.target.value as Settings["order"])}>
              <option value="large">Largest</option>
              <option value="small">Smallest</option>
            </select>
          </label>
        </div>
        <label>
          Layer thickness<span>mm; empty for auto (height ÷ layers)</span>
          <input type="number" min="0.05" step="0.1" placeholder="auto" disabled={!layers}
            value={settings.layerThickness} onChange={(e) => update("layerThickness", e.target.value)} />
        </label>
        <div className="row">
          <label>
            Size<span>longest side, mm</span>
            <input type="number" min="1" step="1" value={settings.size} onChange={(e) => update("size", e.target.valueAsNumber)} />
          </label>
          <label>
            Height<span>{base ? "puzzle, mm" : "Z, mm"}</span>
            <input type="number" min="0.1" step="0.5" value={settings.height} onChange={(e) => update("height", e.target.valueAsNumber)} />
          </label>
        </div>
        <div className="toggle">
          <label className="check">
            <input type="checkbox" checked={settings.slab} onChange={(e) => update("slab", e.target.checked)} />
            Slab
          </label>
        </div>
        <div className="row">
          <label>
            Slab shape<span>outer edge</span>
            <select value={settings.slabShape} disabled={!settings.slab}
              onChange={(e) => update("slabShape", e.target.value as Settings["slabShape"])}>
              <option value="canvas">Canvas</option>
              <option value="square">Square</option>
              <option value="circle">Circle</option>
              <option value="hexagon">Hexagon</option>
            </select>
          </label>
          <label>
            Padding<span>around the art, mm</span>
            <input type="number" min="0" step="0.5" disabled={!settings.slab || settings.slabShape === "canvas"}
              value={settings.slabPadding} onChange={(e) => update("slabPadding", e.target.valueAsNumber)} />
          </label>
        </div>
        <div className="toggle">
          <label className="check">
            <input type="checkbox" disabled={layers} checked={settings.base} onChange={(e) => update("base", e.target.checked)} />
            Base
          </label>
          <input type="number" min="0.1" step="0.5" title="Base thickness, mm, under the puzzle" disabled={!base}
            value={settings.baseThickness} onChange={(e) => update("baseThickness", e.target.valueAsNumber)} />
          <span className="unit">mm</span>
        </div>
        {(settings.slab || base) && palette.length > 0 && (
          <div className="field">
            Base color<span>slab and base; defaults to the color with the most area</span>
            <div className="swatches" role="radiogroup" aria-label="Base color">
              {palette.map((swatch) => (
                <button key={swatch} type="button" role="radio" aria-checked={swatch === selectedBase}
                  className="swatch" style={{ background: swatch }} title={swatch + (swatch === palette[0] ? " (most area)" : "")}
                  onClick={() => setChosenBase(swatch === palette[0] ? null : swatch)} />
              ))}
            </div>
          </div>
        )}
        <label>
          Explode<span>preview only: lifts pieces or layers apart</span>
          <input type="range" min="0" max="3" step="0.05" value={explode} onChange={(e) => update("explode", e.target.valueAsNumber)} />
        </label>
        <button type="button" className="primary" disabled={!result || status.kind === "working"}
          onClick={() => result && download(result.step, "step", "application/step")}>
          Download STEP
        </button>
        <button type="button" className="primary" disabled={!result || status.kind === "working"}
          title="Bambu Studio: a part per color, each on its own filament"
          onClick={() => result && download(export3mf(result.meshes, baseName), "3mf", "model/3mf")}>
          Download 3MF
        </button>
        <div className={`status ${status.kind}`}>{status.message}</div>
      </aside>
      <main {...dragProps}>
        <div className={`pane ${settings.view === "3d" ? "" : "hidden"}`}>
          <Viewer meshes={result?.meshes ?? []} explode={explode} frameKey={`${file?.name}:${settings.size}`} />
          {!file && <div className="hint">Drop an SVG to start</div>}
          <div className="help">Drag to orbit · right-drag to pan · scroll to zoom</div>
        </div>
        {settings.view === "2d" && (
          <div className="pane">
            <Editor editor={result?.editor ?? null} edits={edits} tool={settings.tool} radius={settings.brushRadius} onEdit={addEdit} />
            <div className="toolbar">
              {TOOLS.map(({ tool, label, title }) => (
                <button key={tool} type="button" title={title} aria-pressed={settings.tool === tool}
                  style={{ "--tool": TOOL_COLORS[tool] } as CSSProperties} onClick={() => update("tool", tool)}>
                  {label}
                </button>
              ))}
              <label className="inline" title="Brush radius, mm">
                Brush
                <input type="number" min="0.1" step="0.5" value={settings.brushRadius}
                  onChange={(e) => e.target.valueAsNumber > 0 && update("brushRadius", e.target.valueAsNumber)} />
                <span className="unit">mm</span>
              </label>
              <button type="button" disabled={!edits.length} onClick={undo} title="Undo (⌘Z)">Undo</button>
              <button type="button" disabled={!edits.length} onClick={() => setDocument((d) => ({ ...d, edits: [] }))}>Clear</button>
            </div>
            <div className="help">Paint with the left button · right-drag to pan · scroll to zoom</div>
          </div>
        )}
        <div className="tabs" role="tablist">
          {(["3d", "2d"] as const).map((view) => (
            <button key={view} type="button" role="tab" aria-selected={settings.view === view} onClick={() => update("view", view)}>
              {view === "3d" ? "3D preview" : "2D edit"}
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}

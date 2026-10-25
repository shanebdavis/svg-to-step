import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
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
  slabColor: "#808080",
  slabShape: "canvas" as BuildOptions["slabShape"],
  slabPadding: 5,
  base: false,
  baseThickness: 2,
  explode: 0,
};

type Settings = typeof DEFAULT_SETTINGS;
type Status = { kind: "idle" | "working" | "ready" | "error"; message: string };

const SLAB = "slab";

const toRgb = (hex: string): RGB | null => {
  const rgba = parseColor(hex);
  return rgba && [rgba[0], rgba[1], rgba[2]];
};

/**
 * baseColor is a hex color, SLAB for the slab's color, or null for the color with the most area.
 * maxColors limits the SVG's colors, or null keeps them all.
 */
function toOptions(s: Settings, baseColor: string | null, maxColors: number | null): BuildOptions | null {
  const layerThickness = s.layerThickness.trim() === "" ? null : Number(s.layerThickness);
  const baseThickness = s.mode === "puzzle" && s.base ? s.baseThickness : null;
  const positive = [s.size, s.height, layerThickness ?? 1, baseThickness ?? 1];
  if (!positive.every((v) => v > 0) || !(s.slabPadding >= 0)) return null;
  return {
    ...DEFAULT_OPTIONS,
    mode: s.mode,
    order: s.order,
    size: s.size,
    height: s.height,
    layerThickness,
    slabColor: s.slab ? toRgb(s.slabColor) : null,
    slabShape: s.slabShape,
    slabPadding: s.slabPadding,
    baseThickness,
    baseColor: baseColor ? toRgb(baseColor === SLAB ? s.slabColor : baseColor) : null,
    maxColors,
  };
}

export function App() {
  const [settings, setSettings] = useStoredState("svg2step.settings", DEFAULT_SETTINGS);
  const [{ file, chosenBase, colorLimit }, setDocument] = useStoredState("svg2step.document", {
    file: null as { name: string; text: string } | null,
    chosenBase: null as string | null,
    colorLimit: null as number | null,
  });
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
  const baseColor = chosenBase === SLAB && !settings.slab ? null : chosenBase;
  const options = toOptions(settings, baseColor, colorLimit);
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    if (!file) return;
    if (!options) {
      setStatus({ kind: "error", message: "Size, height and thicknesses must be positive numbers, padding zero or more." });
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
          setStatus({
            kind: "ready",
            message: `${solids} solids, ${colors} colors\n${size.map((v) => v.toFixed(2)).join(" × ")} mm\nbuilt in ${seconds.toFixed(1)} s`,
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

  // A color limit can merge away the chosen base color.
  useEffect(() => {
    if (result && chosenBase && chosenBase !== SLAB && !result.palette.includes(chosenBase)) setChosenBase(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const openFile = useCallback(async (picked: File | undefined) => {
    if (!picked) return;
    const text = await picked.text();
    setDocument({ file: { name: picked.name, text }, chosenBase: null, colorLimit: null });
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
  const swatches = settings.slab && !palette.includes(settings.slabColor) ? [...palette, SLAB] : palette;
  const selectedBase = baseColor ?? palette[0];
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
          <input type="color" title="Slab color" disabled={!settings.slab} value={settings.slabColor}
            onChange={(e) => update("slabColor", e.target.value)} />
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
        {base && swatches.length > 0 && (
          <div className="field">
            Base color<span>defaults to the color with the most area</span>
            <div className="swatches" role="radiogroup" aria-label="Base color">
              {swatches.map((swatch) => {
                const hex = swatch === SLAB ? settings.slabColor : swatch;
                const note = swatch === SLAB ? " (slab)" : swatch === palette[0] ? " (most area)" : "";
                return (
                  <button key={swatch} type="button" role="radio" aria-checked={swatch === selectedBase}
                    className="swatch" style={{ background: hex }} title={hex + note}
                    onClick={() => setChosenBase(swatch === palette[0] ? null : swatch)} />
                );
              })}
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
        <Viewer meshes={result?.meshes ?? []} explode={explode} frameKey={`${file?.name}:${settings.size}`} />
        {!file && <div className="hint">Drop an SVG to start</div>}
        <div className="help">Drag to orbit · right-drag to pan · scroll to zoom</div>
      </main>
    </div>
  );
}

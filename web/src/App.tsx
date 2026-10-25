import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { DEFAULT_OPTIONS, type BuildOptions } from "./engine/build";
import { buildModel, loadEngine, Superseded } from "./engine/client";
import type { BuildResult } from "./engine/protocol";
import { parseColor, type RGB } from "./engine/svg/color";
import { useStoredState } from "./useStoredState";
import { Viewer } from "./Viewer";

const DEFAULT_SETTINGS = {
  mode: "puzzle" as BuildOptions["mode"],
  order: "large" as BuildOptions["order"],
  layerThickness: "",
  size: 150,
  height: 5,
  slab: true,
  slabColor: "#808080",
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

/** baseColor is a hex color, SLAB for the slab's color, or null for the color with the most area. */
function toOptions(s: Settings, baseColor: string | null): BuildOptions | null {
  const layerThickness = s.layerThickness.trim() === "" ? null : Number(s.layerThickness);
  const baseThickness = s.mode === "puzzle" && s.base ? s.baseThickness : null;
  const positive = [s.size, s.height, layerThickness ?? 1, baseThickness ?? 1];
  if (!positive.every((v) => v > 0)) return null;
  return {
    ...DEFAULT_OPTIONS,
    mode: s.mode,
    order: s.order,
    size: s.size,
    height: s.height,
    layerThickness,
    slabColor: s.slab ? toRgb(s.slabColor) : null,
    baseThickness,
    baseColor: baseColor ? toRgb(baseColor === SLAB ? s.slabColor : baseColor) : null,
  };
}

export function App() {
  const [settings, setSettings] = useStoredState("svg2step.settings", DEFAULT_SETTINGS);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [chosenBase, setChosenBase] = useState<string | null>(null);
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
  const options = toOptions(settings, baseColor);
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    if (!file) return;
    if (!options) {
      setStatus({ kind: "error", message: "Size, height and thicknesses must be positive numbers." });
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

  const openFile = useCallback(async (picked: File | undefined) => {
    if (!picked) return;
    setFile({ name: picked.name, text: await picked.text() });
    setResult(null);
    setChosenBase(null);
  }, []);

  const download = () => {
    if (!result || !file) return;
    const url = URL.createObjectURL(new Blob([result.step as BlobPart], { type: "application/step" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name.replace(/\.svg$/i, "") + ".step";
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
        <button type="button" className="primary" disabled={!result || status.kind === "working"} onClick={download}>
          Download STEP
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

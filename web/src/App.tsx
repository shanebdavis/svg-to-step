import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { DEFAULT_OPTIONS, type BuildOptions } from "./engine/build";
import { buildModel, loadEngine, Superseded } from "./engine/client";
import type { BuildResult } from "./engine/protocol";
import { parseColor } from "./engine/svg/color";
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
  explode: 0,
};

type Settings = typeof DEFAULT_SETTINGS;
type Status = { kind: "idle" | "working" | "ready" | "error"; message: string };

function toOptions(s: Settings): BuildOptions | null {
  const layerThickness = s.layerThickness.trim() === "" ? null : Number(s.layerThickness);
  if (!(s.size > 0) || !(s.height > 0) || (layerThickness !== null && !(layerThickness > 0))) return null;
  const rgba = parseColor(s.slabColor);
  return {
    ...DEFAULT_OPTIONS,
    mode: s.mode,
    order: s.order,
    size: s.size,
    height: s.height,
    layerThickness,
    slabColor: s.slab && rgba ? [rgba[0], rgba[1], rgba[2]] : null,
  };
}

export function App() {
  const [settings, setSettings] = useStoredState("svg2step.settings", DEFAULT_SETTINGS);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
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
  const options = toOptions(settings);
  const optionsKey = JSON.stringify(options);

  useEffect(() => {
    if (!file) return;
    if (!options) {
      setStatus({ kind: "error", message: "Size, height and layer thickness must be positive numbers." });
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
            Height<span>Z, mm</span>
            <input type="number" min="0.1" step="0.5" value={settings.height} onChange={(e) => update("height", e.target.valueAsNumber)} />
          </label>
        </div>
        <div className="slab">
          <label className="check">
            <input type="checkbox" checked={settings.slab} onChange={(e) => update("slab", e.target.checked)} />
            Slab
          </label>
          <input type="color" title="Slab color" disabled={!settings.slab} value={settings.slabColor}
            onChange={(e) => update("slabColor", e.target.value)} />
        </div>
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

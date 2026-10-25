import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { fromPaths, paintMasks, type BrushMode, type Masks, type Stroke } from "./engine/features";
import type { BuildResult } from "./engine/protocol";
import type { Point } from "./engine/svg/geometry";

/** One undoable edit: a brush stroke, or a click that deletes or restores a shape. */
export type Edit = { kind: "stroke"; stroke: Stroke } | { kind: "pick"; shape: number };

export type Tool = BrushMode | "pick";

export const strokesOf = (edits: Edit[]) => edits.flatMap((e) => (e.kind === "stroke" ? [e.stroke] : []));

/** Shapes picked an odd number of times. */
export function pickedShapes(edits: Edit[]): number[] {
  const picked = new Set<number>();
  for (const e of edits) if (e.kind === "pick") picked.has(e.shape) ? picked.delete(e.shape) : picked.add(e.shape);
  return [...picked];
}

export const TOOL_COLORS: Record<Tool, string> = {
  delete: "#e5484d", merge: "#f5a524", thicken: "#3e7bfa", keep: "#30a46c", erase: "#8b8d98", pick: "#e5484d",
};

const pathData = (polygons: Point[][]) => polygons.map((p) => `M${p.map(([x, y]) => `${x} ${y}`).join("L")}Z`).join("");

interface Props {
  editor: BuildResult["editor"] | null;
  edits: Edit[];
  tool: Tool;
  /** Brush radius, mm. */
  radius: number;
  onEdit: (edit: Edit) => void;
}

interface View { x: number; y: number; w: number; h: number }

export function Editor({ editor, edits, tool, radius, onEdit }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const layer = useRef<SVGGElement>(null);
  const [view, setView] = useState<View | null>(null);
  // Pointer events can outpace renders, so the stroke in progress lives in a ref; state redraws it.
  const drawing = useRef<Point[] | null>(null);
  const [stroke, setStroke] = useState<Point[] | null>(null);
  const draw = (points: Point[] | null) => {
    drawing.current = points;
    setStroke(points);
  };
  const [cursor, setCursor] = useState<Point | null>(null);
  const pan = useRef<{ from: Point; view: View } | null>(null);
  const masks: Masks = useMemo(() => paintMasks(strokesOf(edits)), [edits]);

  const fitKey = editor && `${editor.width}x${editor.height}`;
  useEffect(() => {
    if (!editor) return;
    const margin = Math.max(editor.width, editor.height) * 0.05;
    setView({ x: -margin, y: -margin, w: editor.width + 2 * margin, h: editor.height + 2 * margin });
    // Re-fit only when the canvas changes, not on every rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  /** Model coordinates under a pointer. */
  const toModel = (clientX: number, clientY: number): Point => {
    const matrix = layer.current!.getScreenCTM()!.inverse();
    const p = new DOMPoint(clientX, clientY).matrixTransform(matrix);
    return [p.x, p.y];
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (!view) return;
    svg.current!.setPointerCapture(e.pointerId);
    if (e.button !== 0) {
      pan.current = { from: [e.clientX, e.clientY], view };
      return;
    }
    if (tool === "pick") {
      const index = (e.target as SVGElement).dataset.shape;
      if (index !== undefined) onEdit({ kind: "pick", shape: Number(index) });
      return;
    }
    draw([toModel(e.clientX, e.clientY)]);
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (pan.current) {
      const { from, view: start } = pan.current;
      // The viewBox is letterboxed to fit, so the tighter axis sets the scale.
      const scale = Math.max(start.w / svg.current!.clientWidth, start.h / svg.current!.clientHeight);
      setView({ ...start, x: start.x - (e.clientX - from[0]) * scale, y: start.y + (e.clientY - from[1]) * scale });
      return;
    }
    const p = toModel(e.clientX, e.clientY);
    setCursor(p);
    const points = drawing.current;
    if (points) {
      const last = points[points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > radius / 4) draw([...points, p]);
    }
  };

  const onPointerUp = () => {
    pan.current = null;
    const points = drawing.current;
    // Strokes are stored before the fit to size, so they stay on the art when padding or size change.
    const fit = editor?.fit ?? 1;
    if (points && tool !== "pick") {
      onEdit({ kind: "stroke", stroke: { mode: tool, radius: radius / fit, points: points.map(([x, y]) => [x / fit, y / fit]) } });
    }
    draw(null);
  };

  const onWheel = (e: WheelEvent<SVGSVGElement>) => {
    if (!view) return;
    const [mx, my] = toModel(e.clientX, e.clientY);
    const factor = Math.exp(e.deltaY * 0.0015);
    setView({ x: mx - (mx - view.x) * factor, y: my - (my - view.y) * factor, w: view.w * factor, h: view.h * factor });
  };

  if (!editor || !view) return <div className="hint">Drop an SVG to edit it</div>;
  const deleted = new Set(editor.deleted);
  const unit = view.w / 800;
  const color = TOOL_COLORS[tool];
  return (
    <svg ref={svg} className={`editor tool-${tool}`} viewBox={`${view.x} ${-(view.y + view.h)} ${view.w} ${view.h}`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerLeave={() => setCursor(null)} onWheel={onWheel} onContextMenu={(e) => e.preventDefault()}>
      <defs>
        <pattern id="deleted" width={4 * unit} height={4 * unit} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2={4 * unit} stroke={TOOL_COLORS.delete} strokeWidth={unit} />
        </pattern>
      </defs>
      <g ref={layer} transform="scale(1,-1)">
        <rect className="canvas" width={editor.width} height={editor.height} />
        {editor.shapes.map((shape, i) => !deleted.has(i) && (
          <path key={i} data-shape={i} d={shape.d} fillRule={shape.fillRule} fill={shape.color} />
        ))}
        <g transform={`scale(${editor.fit})`}>
          {(["delete", "keep", "merge", "thicken"] as const).map((mode) => (
            <path key={mode} className="paint" d={pathData(fromPaths(masks[mode]))} fill={TOOL_COLORS[mode]} />
          ))}
        </g>
        {editor.changes.map((change, i) => (
          <path key={i} className="change" d={change.d} fill={TOOL_COLORS[change.mode]} stroke={TOOL_COLORS[change.mode]} />
        ))}
        {/* Deleted shapes on top, so ones hidden under others can still be seen and restored. */}
        {editor.shapes.map((shape, i) => deleted.has(i) && (
          <path key={`deleted-${i}`} data-shape={i} className="deleted" d={shape.d} fillRule={shape.fillRule} />
        ))}
        {stroke && (
          <polyline className="stroke" points={stroke.map((p) => p.join(",")).join(" ")}
            stroke={color} strokeWidth={2 * radius} />
        )}
        {cursor && tool !== "pick" && (
          <circle className="brush" cx={cursor[0]} cy={cursor[1]} r={radius} stroke={color} strokeWidth={unit} />
        )}
      </g>
    </svg>
  );
}

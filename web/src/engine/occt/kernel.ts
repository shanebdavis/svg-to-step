/**
 * Thin helpers over the OpenCascade WebAssembly build.
 *
 * Geometry runs in a short-lived worker per build, so WASM memory is
 * reclaimed when the worker ends rather than object by object.
 */

import type { OpenCascadeInstance, TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopoDS_Solid, TopoDS_Wire } from "replicad-opencascadejs";
import {
  flatten, pointInPolygon, polygonArea, polygonsCross, windingNumber, type Contour, type Point, type Segment,
} from "../svg/geometry";

export type OC = OpenCascadeInstance;

let oc: OC;

export function setOC(instance: OC): void {
  oc = instance;
}

export function getOC(): OC {
  if (!oc) throw new Error("OpenCascade is not loaded");
  return oc;
}

const pnt = (x: number, y: number, z = 0) => new oc.gp_Pnt(x, y, z);
const Z = () => new oc.gp_Dir(0, 0, 1);
const progress = () => new oc.Message_ProgressRange();

export interface Box { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

/** Unique sub-shapes of a type, in exploration order. */
function explore<T extends TopoDS_Shape>(shape: TopoDS_Shape, type: "FACE" | "EDGE" | "WIRE" | "SOLID", cast: (s: TopoDS_Shape) => T): T[] {
  const result: T[] = [];
  if (!shape || shape.IsNull()) return result;
  const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum[`TopAbs_${type}`], oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; explorer.More(); explorer.Next()) {
    const current = explorer.Current();
    if (!result.some((s) => s.IsSame(current))) result.push(cast(current));
  }
  explorer.delete();
  return result;
}

export const facesOf = (shape: TopoDS_Shape) => explore(shape, "FACE", (s) => oc.TopoDS.Face(s));
export const edgesOf = (shape: TopoDS_Shape) => explore(shape, "EDGE", (s) => oc.TopoDS.Edge(s));
export const solidsOf = (shape: TopoDS_Shape) => explore(shape, "SOLID", (s) => oc.TopoDS.Solid(s));

export function area(shape: TopoDS_Shape): number {
  const props = new oc.GProp_GProps();
  oc.BRepGProp.SurfaceProperties(shape, props, false, false);
  const mass = props.Mass();
  props.delete();
  return mass;
}

export function volume(shape: TopoDS_Shape): number {
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
  const mass = props.Mass();
  props.delete();
  return mass;
}

export function edgeLength(edge: TopoDS_Edge): number {
  const props = new oc.GProp_GProps();
  oc.BRepGProp.LinearProperties(edge, props, false, false);
  const mass = props.Mass();
  props.delete();
  return mass;
}

export function boundingBox(shape: TopoDS_Shape): Box {
  const box = new oc.Bnd_Box();
  oc.BRepBndLib.Add(shape, box, false);
  const result = {
    minX: box.GetXMin(), minY: box.GetYMin(), minZ: box.GetZMin(),
    maxX: box.GetXMax(), maxY: box.GetYMax(), maxZ: box.GetZMax(),
  };
  box.delete();
  return result;
}

function list(shapes: TopoDS_Shape[]) {
  const l = new oc.NCollection_List_TopoDS_Shape();
  for (const s of shapes) l.Append(s);
  return l;
}

/** Boolean ops never simplify: unifying edges would replace SVG curves with approximations. */
export function fuse(shapes: TopoDS_Shape[]): TopoDS_Shape {
  if (shapes.length === 1) return shapes[0];
  const op = new oc.BRepAlgoAPI_Fuse();
  op.SetArguments(list(shapes.slice(0, 1)));
  op.SetTools(list(shapes.slice(1)));
  op.Build(progress());
  if (!op.IsDone()) throw new Error("Fuse failed");
  return op.Shape();
}

export function cut(shape: TopoDS_Shape, tool: TopoDS_Shape): TopoDS_Shape {
  const op = new oc.BRepAlgoAPI_Cut(shape, tool, progress());
  if (!op.IsDone()) throw new Error("Cut failed");
  return op.Shape();
}

export function common(shape: TopoDS_Shape, tool: TopoDS_Shape): TopoDS_Shape {
  const op = new oc.BRepAlgoAPI_Common(shape, tool, progress());
  if (!op.IsDone()) throw new Error("Intersect failed");
  return op.Shape();
}

/** Merge coplanar faces only. Edges stay untouched; see fuse. */
export function unifyFaces(shape: TopoDS_Shape): TopoDS_Shape {
  const unify = new oc.ShapeUpgrade_UnifySameDomain(shape, false, true, false);
  unify.Build();
  return unify.Shape();
}

/** Repair a face; self-intersecting outlines split into several valid faces. */
export function repairFace(face: TopoDS_Face): TopoDS_Face[] {
  const fix = new oc.ShapeFix_Face(face);
  fix.Perform(progress());
  return facesOf(fix.Result());
}

export function isValid(shape: TopoDS_Shape): boolean {
  const check = new oc.BRepCheck_Analyzer(shape, true, false, false);
  const valid = check.IsValid();
  check.delete();
  return valid;
}

export function distanceToPoint(shape: TopoDS_Shape, [x, y]: Point): number {
  const vertex = new oc.BRepBuilderAPI_MakeVertex(pnt(x, y)).Vertex();
  const distance = new oc.BRepExtrema_DistShapeShape(shape, vertex);
  const value = distance.IsDone() ? distance.Value() : Infinity;
  distance.delete();
  return value;
}

/** Evenly spaced parameter samples along an edge. */
export function edgeSamples(edge: TopoDS_Edge, count: number): Point[] {
  const curve = new oc.BRepAdaptor_Curve(edge);
  const first = curve.FirstParameter();
  const last = curve.LastParameter();
  const points = Array.from({ length: count }, (_, j) => {
    const p = curve.Value(first + ((j + 0.5) / count) * (last - first));
    return [p.X(), p.Y()] as Point;
  });
  curve.delete();
  return points;
}

export function translate(shape: TopoDS_Shape, dx: number, dy: number, dz: number): TopoDS_Shape {
  const trsf = new oc.gp_Trsf();
  trsf.SetTranslation(new oc.gp_Vec(dx, dy, dz));
  return new oc.BRepBuilderAPI_Transform(shape, trsf, false, false).Shape();
}

export function extrude(face: TopoDS_Face, z: number, thickness: number): TopoDS_Solid {
  const base = z ? translate(face, 0, 0, z) : face;
  const prism = new oc.BRepPrimAPI_MakePrism(base, new oc.gp_Vec(0, 0, thickness), false, true);
  return oc.TopoDS.Solid(prism.Shape());
}

export function rectangleFace(width: number, height: number): TopoDS_Face {
  const corners: Point[] = [[0, 0], [width, 0], [width, height], [0, height]];
  const segments: Segment[] = corners.map((from, i) => ({ kind: "line", from, to: corners[(i + 1) % 4] }));
  return faceFromWires(wireFromContour({ kind: "path", segments }), []);
}

function edgeFromSegment(s: Segment): TopoDS_Edge {
  switch (s.kind) {
    case "line":
      return new oc.BRepBuilderAPI_MakeEdge(pnt(...s.from), pnt(...s.to)).Edge();
    case "cubic": {
      const poles = new oc.NCollection_Array1_gp_Pnt(1, 4);
      [s.from, s.c1, s.c2, s.to].forEach((p, i) => poles.SetValue(i + 1, pnt(...p)));
      return new oc.BRepBuilderAPI_MakeEdge(new oc.Geom_BezierCurve(poles)).Edge();
    }
    case "arc":
      return new oc.BRepBuilderAPI_MakeEdge(new oc.GC_MakeArcOfCircle(pnt(...s.from), pnt(...s.via), pnt(...s.to)).Value()).Edge();
  }
}

export function wireFromContour(contour: Contour): TopoDS_Wire {
  if (contour.kind === "circle") {
    const circle = new oc.gp_Circ(new oc.gp_Ax2(pnt(...contour.center), Z()), contour.radius);
    return new oc.BRepBuilderAPI_MakeWire(new oc.BRepBuilderAPI_MakeEdge(circle).Edge()).Wire();
  }
  if (contour.kind === "ellipse") {
    // OpenCascade needs major >= minor; rotate the frame a quarter turn when ry is larger.
    const swap = contour.ry > contour.rx;
    const angle = contour.angle + (swap ? Math.PI / 2 : 0);
    const axes = new oc.gp_Ax2(pnt(...contour.center), Z(), new oc.gp_Dir(Math.cos(angle), Math.sin(angle), 0));
    const ellipse = new oc.gp_Elips(axes, Math.max(contour.rx, contour.ry), Math.min(contour.rx, contour.ry));
    return new oc.BRepBuilderAPI_MakeWire(new oc.BRepBuilderAPI_MakeEdge(ellipse).Edge()).Wire();
  }
  const wire = new oc.BRepBuilderAPI_MakeWire();
  for (const segment of contour.segments) wire.Add(edgeFromSegment(segment));
  if (!wire.IsDone()) throw new Error("Could not connect path segments into a closed outline");
  return wire.Wire();
}

/** Planar face with normal +Z; ShapeFix orients the wires to suit it. */
export function faceFromWires(outer: TopoDS_Wire, inners: TopoDS_Wire[]): TopoDS_Face {
  const plane = new oc.gp_Pln(pnt(0, 0), Z());
  const builder = new oc.BRepBuilderAPI_MakeFace(plane, outer, true);
  for (const inner of inners) builder.Add(inner);
  const fix = new oc.ShapeFix_Face(builder.Face());
  fix.FixOrientation();
  return oc.TopoDS.Face(fix.Face());
}

export type FillRule = "nonzero" | "evenodd";

const filled = (winding: number, rule: FillRule) => (rule === "evenodd" ? winding % 2 !== 0 : winding !== 0);

/** Faces covering what an element fills under its fill rule. */
export function facesFromContours(contours: Contour[], rule: FillRule): TopoDS_Face[] {
  const polygons = contours.map((c) => flatten(c, 24));
  return polygonsCross(polygons)
    ? arrangementFaces(contours, polygons, rule)
    : nestedFaces(contours, polygons, rule);
}

/**
 * Non-crossing contours nest by containment. Each region between a contour and
 * the contours directly inside it is filled by its winding number.
 */
function nestedFaces(contours: Contour[], polygons: Point[][], rule: FillRule): TopoDS_Face[] {
  const signedAreas = polygons.map(polygonArea);
  const areas = signedAreas.map(Math.abs);
  const inside = (i: number, j: number) => {
    if (areas[j] <= areas[i]) return false;
    const samples = polygons[i].filter((_, k) => k % Math.max(1, Math.floor(polygons[i].length / 9)) === 0);
    return samples.filter((p) => pointInPolygon(p, polygons[j])).length * 2 > samples.length;
  };
  const indices = contours.map((_, i) => i);
  const containers = indices.map((i) => indices.filter((j) => i !== j && inside(i, j)));
  const direction = (i: number) => Math.sign(signedAreas[i]);
  const wires = contours.map(wireFromContour);
  const faces: TopoDS_Face[] = [];
  for (const i of indices) {
    const winding = direction(i) + containers[i].reduce((sum, j) => sum + direction(j), 0);
    if (!filled(winding, rule)) continue;
    const holes = indices.filter((j) => containers[j].length === containers[i].length + 1 && containers[j].includes(i));
    faces.push(faceFromWires(wires[i], holes.map((j) => wires[j])));
  }
  return faces;
}

/**
 * Crossing contours: split a bounding rectangle along every edge, then keep
 * the cells whose winding number the fill rule fills.
 */
function arrangementFaces(contours: Contour[], polygons: Point[][], rule: FillRule): TopoDS_Face[] {
  const xs = polygons.flat().map((p) => p[0]);
  const ys = polygons.flat().map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const margin = Math.max(maxX - minX, maxY - minY) * 0.01 + 1;
  const bounds = translate(rectangleFace(maxX - minX + 2 * margin, maxY - minY + 2 * margin), minX - margin, minY - margin, 0);

  const splitter = new oc.BRepAlgoAPI_Splitter();
  splitter.SetArguments(list([bounds]));
  splitter.SetTools(list(contours.flatMap((c) => edgesOf(wireFromContour(c)))));
  splitter.Build(progress());
  if (!splitter.IsDone()) throw new Error("Could not resolve a self-intersecting path");

  const kept = facesOf(splitter.Shape()).filter((cell) => filled(windingNumber(interiorPoint(cell), polygons), rule));
  return kept.length > 1 ? facesOf(unifyFaces(fuse(kept))) : kept;
}

/** A point well inside a face: the centroid of its largest mesh triangle. */
function interiorPoint(face: TopoDS_Face): Point {
  const box = boundingBox(face);
  const { positions, indices } = mesh(face, Math.max(box.maxX - box.minX, box.maxY - box.minY) * 1e-3, 0.2);
  let best: Point = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
  let bestArea = -1;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((k) => [positions[3 * k], positions[3 * k + 1]]);
    const triangleArea = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
    if (triangleArea > bestArea) {
      bestArea = triangleArea;
      best = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    }
  }
  return best;
}

export interface MeshData { positions: Float32Array; indices: Uint32Array }

export function mesh(shape: TopoDS_Shape, tolerance: number, angularTolerance: number): MeshData {
  const raw = oc.ReplicadMeshExtractor.extract(shape, tolerance, angularTolerance, true);
  const buffer = oc.wasmMemory.buffer;
  const positions = new Float32Array(buffer, raw.getVerticesPtr(), raw.getVerticesSize()).slice();
  const indices = new Uint32Array(buffer, raw.getTrianglesPtr(), raw.getTrianglesSize()).slice();
  raw.delete();
  return { positions, indices };
}

export interface StepPart { shape: TopoDS_Shape; name: string; color: readonly [number, number, number] }

/** STEP AP214 with a named, colored body per part. */
export function exportStep(parts: StepPart[]): Uint8Array {
  const text = (s: string) => new oc.TCollection_ExtendedString(s, true);
  const doc = new oc.TDocStd_Document(text("XmlOcaf"));
  oc.XCAFDoc_ShapeTool.SetAutoNaming(false);
  const shapes = oc.XCAFDoc_DocumentTool.ShapeTool(doc.Main());
  const colors = oc.XCAFDoc_DocumentTool.ColorTool(doc.Main());
  for (const part of parts) {
    const label = shapes.NewShape();
    shapes.SetShape(label, part.shape);
    oc.TDataStd_Name.Set(label, text(part.name));
    colors.SetColor(label, new oc.Quantity_ColorRGBA(...part.color, 1), oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
  }
  shapes.UpdateAssemblies();
  const writer = new oc.STEPCAFControl_Writer(new oc.XSControl_WorkSession(), false);
  writer.SetColorMode(true);
  writer.SetNameMode(true);
  oc.Interface_Static.SetIVal("write.step.schema", 5);
  const path = "/model.step";
  if (!writer.Perform(doc, path, progress())) throw new Error("STEP export failed");
  const bytes = oc.FS.readFile(path);
  oc.FS.unlink(path);
  return bytes;
}

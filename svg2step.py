"""Convert an SVG into a flat, colored STEP model.

Puzzle mode: the SVG canvas becomes a solid slab with every painted shape cut
out of it. Each visible connected region of a single color becomes its own
solid that fills its cutout exactly.

Layers mode: one equal-thickness layer per color, stacked so each color shows
from the top at its own step height.

Either way, overlaps resolve by paint order, so the top view shows exactly what
the SVG renders.
"""

import argparse
from collections import defaultdict
from pathlib import Path

from build123d import (
    Color, Compound, Face, Rectangle, SkipClean, Vector, export_step, extrude,
)
from ocpsvg import ColorAndLabel, import_svg_document
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.TopoDS import TopoDS_Face


def load_painted_faces(svg_path):
    """Filled SVG regions in paint order (bottom first), plus the viewBox."""
    doc = import_svg_document(
        str(svg_path), flip_y=True, metadata=ColorAndLabel.Label_by("id")
    )
    painted = []
    for shape, meta in doc:
        if isinstance(shape, TopoDS_Face):
            r, g, b, a = meta.color_for(shape)
            if a > 0:
                painted.append((Face(shape).fix(), (round(r, 4), round(g, 4), round(b, 4))))
    return painted, doc.viewbox


def faces_of(shape):
    return list(shape.faces()) if shape else []


def cut(face, cutter):
    return faces_of(face.cut(cutter)) if cutter else [face]


def visible_regions(painted, canvas):
    """Visible part of each color, top-down so higher shapes win overlaps."""
    by_color = defaultdict(list)
    covered = None
    for face, color in reversed(painted):
        for part in cut(face, covered):
            by_color[color].extend(faces_of(part.intersect(canvas)))
        covered = face if covered is None else covered.fuse(face)
    return {c: f for c, f in by_color.items() if f}, covered


def merge_touching(faces):
    """Fuse same-color fragments, then split into connected regions.

    Only faces are unified. Unifying edges would replace chains of SVG curves
    with approximating B-splines that no longer match the neighboring pieces.
    """
    if len(faces) == 1:
        return faces
    fused = faces[0].fuse(*faces[1:])
    unify = ShapeUpgrade_UnifySameDomain(fused.wrapped, False, True, False)
    unify.Build()
    return faces_of(Compound(unify.Shape()))


def to_hex(rgb):
    return "#" + "".join(f"{round(c * 255):02x}" for c in rgb)


def parse_hex(value):
    """RGB from "#rrggbb", or None for "none"."""
    if not value or value.lower() == "none":
        return None
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))


def build(svg_path, size, height, bg_color, mode="puzzle", order="large"):
    """bg_color of None leaves out the slab, so only the SVG's colors are built.

    mode "puzzle": every color region is a full-height piece set into the slab.
    mode "layers": one equal-thickness layer per color, stacked by area
    (order "large" or "small" first). Each layer covers its own color's region
    plus every region above it, so each color shows from the top at its own step.

    Each solid gets a `level` (0 = bottom) for exploded previews.
    """
    # build123d's automatic clean would also unify edges; see merge_touching.
    with SkipClean():
        return _build(svg_path, size, height, bg_color, mode, order)


def _build(svg_path, size, height, bg_color, mode, order):
    painted, vb = load_painted_faces(svg_path)
    scale = size / max(vb.width, vb.height)
    # The importer reports the viewBox already flipped into Y-up coordinates.
    canvas = Rectangle(vb.width, vb.height).translate(
        Vector(vb.x + vb.width / 2, vb.y + vb.height / 2)
    ).faces()[0]

    by_color, covered = visible_regions(painted, canvas)
    regions = {rgb: merge_touching(faces) for rgb, faces in by_color.items()}
    background = cut(canvas, covered) if bg_color else []

    def to_solid(face, label, rgb, level, z=0.0, thickness=height):
        solid = extrude(face.scale(scale).translate(Vector(0, 0, z)), amount=thickness)
        solid.label, solid.color, solid.level = label, Color(*rgb), level
        return solid

    solids = []
    if mode == "puzzle":
        for i, face in enumerate(background, 1):
            solids.append(to_solid(face, f"background-{i}", bg_color, 0))
        for rgb, faces in regions.items():
            for i, face in enumerate(faces, 1):
                solids.append(to_solid(face, f"{to_hex(rgb)}-{i}", rgb, 1))
    else:
        layers = sorted(regions.items(), key=lambda item: sum(f.area for f in item[1]),
                        reverse=order == "large")
        if bg_color:
            layers.insert(0, (bg_color, background))
        thickness = height / len(layers)
        for level, (rgb, _) in enumerate(layers):
            footprint = [face for _, faces in layers[level:] for face in faces]
            for i, face in enumerate(merge_touching(footprint), 1):
                label = f"L{level + 1}-{to_hex(rgb)}-{i}"
                solids.append(to_solid(face, label, rgb, level, level * thickness, thickness))

    # Place the canvas corner at the origin, so pieces land in the same spot with or without the slab.
    corner = Vector(vb.x, vb.y) * scale
    solids = [solid.translate(-corner) for solid in solids]
    return Compound(label=Path(svg_path).stem, children=solids), by_color


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("svg", type=Path)
    parser.add_argument("--size", type=float, required=True,
                        help="length of the longest side of the SVG canvas, in mm")
    parser.add_argument("--height", type=float, required=True,
                        help="extrusion height (Z), in mm")
    parser.add_argument("--bg-color", default="#808080",
                        help='color of the slab the shapes are cut from (default gray), or "none" for no slab')
    parser.add_argument("--mode", choices=["puzzle", "layers"], default="puzzle",
                        help="puzzle: full-height pieces set into the slab; "
                             "layers: one stacked layer per color")
    parser.add_argument("--order", choices=["large", "small"], default="large",
                        help="layers mode: stack colors largest-area or smallest-area first")
    parser.add_argument("-o", "--output", type=Path,
                        help="output STEP path (default: alongside the SVG)")
    args = parser.parse_args()

    model, by_color = build(args.svg, args.size, args.height, parse_hex(args.bg_color),
                            args.mode, args.order)
    output = args.output or args.svg.with_suffix(".step")
    export_step(model, str(output))

    bbox = model.bounding_box()
    print(f"{output}: {len(model.solids())} solids, {len(by_color)} colors, "
          f"{bbox.size.X:.2f} x {bbox.size.Y:.2f} x {bbox.size.Z:.2f} mm")


if __name__ == "__main__":
    main()

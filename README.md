# svg-to-step

Turns an SVG into a flat, colored STEP "puzzle". Built for importing into Shapr3D and printing on a multi-material (tool-changer) printer.

- The SVG canvas (viewBox) becomes a gray slab with every painted shape cut out of it.
- Each visible, connected, single-color region becomes its own solid, colored to match the SVG. It fills its cutout exactly, with no clearance.
- Overlapping shapes resolve by paint order: pieces show exactly what the SVG renders.
- Curves stay true curves (circles, arcs, Beziers), not polygon facets.

## Setup

```sh
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Usage

```sh
.venv/bin/python svg2step.py art.svg --size 150 --height 5
```

- `--size`: longest side of the slab, in mm. The SVG scales uniformly to fit.
- `--height`: extrusion height, in mm.
- `--bg-color`: slab color, default `#808080`.
- `-o`: output path, default `art.step` next to the SVG.

## Limitations

- Only fills become geometry. Strokes are ignored; convert them to paths first (Inkscape: Path > Stroke to Path).
- `fill-rule` is treated as even-odd. A nonzero path whose subpaths overlap in the same direction (e.g. a self-intersecting star) gets holes where the browser shows fill.
- Gradients and patterns are not supported; use flat colors.

## GUI

```sh
.venv/bin/python app.py
```

Opens a local page at http://localhost:8765. Drop in an SVG, adjust size, height and slab color, and the 3D preview updates live. "Lift pieces" raises the colored pieces off the slab to check the fit. Download STEP saves the current model.

# svg-to-step

Turns an SVG into a flat, colored STEP model. Built for importing into Shapr3D and printing on a multi-material (tool-changer) printer.

There are two modes:

- **Puzzle** (default): full-height pieces set into a slab, described below.
- **Layers**: one layer per color, stacked in area order (largest or smallest first). Each layer covers its own color plus every color above it, so the bottom layer is solid and each color shows from the top at its own step height. With the slab on, the slab is the bottom layer.

Puzzle mode details:

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
- `--bg-color`: slab color, default `#808080`. Use `none` for pieces only, no slab.
- `--min-area`: regions smaller than this (mm², default 0.5) merge into the neighbor they share the most border with. Removes unprintable slivers left by nearly coincident edges in the artwork.
- `--mode`: `puzzle` (default) or `layers`.
- `--order`: layers mode stacking, `large` (default) or `small` area first.
- `--layer-thickness`: layers mode, fixed mm per layer. Default splits the height evenly. If layers × thickness exceeds the height, the model gets taller; if it falls short, the bottom layer takes the extra.
- `-o`: output path, default `art.step` next to the SVG.

## Limitations

- Only fills become geometry. Strokes are ignored; convert them to paths first (Inkscape: Path > Stroke to Path).
- `fill-rule` is treated as even-odd. A nonzero path whose subpaths overlap in the same direction (e.g. a self-intersecting star) gets holes where the browser shows fill.
- Gradients and patterns are not supported; use flat colors.

## GUI

Double-click `Start SVG to STEP.command` in Finder. The first run sets up the Python environment (about a minute). Close the Terminal window to stop the app. From a shell, `.venv/bin/python app.py` does the same.

It opens a local page at http://localhost:8765. Drop in an SVG, adjust size, height and slab color (or turn the slab off), and the 3D preview updates live. Settings are remembered between visits. "Explode" lifts pieces or layers apart to check the fit. Download STEP saves the current model.

## Browser version (web/)

A TypeScript rewrite that runs entirely in the browser: no server, no Python. The CAD engine is the same OpenCascade kernel, compiled to WebAssembly (a ~7 MB gzipped download, cached after the first visit). It builds to static files that any web host can serve.

Double-click `Start SVG to STEP (Web).command`. It builds the app when the sources change (needs Node.js) and serves it at http://localhost:8775.

```sh
cd web
npm install
npm start        # development server, opens the browser
npm run serve    # production build, served at http://localhost:8775
npm test         # parity with svg2step.py, fill rules, SVG parsing, STEP output
npm run build    # static site in web/dist
```

`web/dist` must be served over HTTP. Browsers block module scripts, workers and WebAssembly on pages opened from a file, so opening `dist/index.html` directly shows instructions instead of the app.

Differences from the Python version:

- `fill-rule` is honored: `nonzero` paths fill overlapping and self-intersecting areas the way browsers do.
- Elliptical arcs and non-uniformly scaled circles become Bezier curves; circles, circular arcs and ellipses stay exact.

`web/test/reference.json` holds svg2step.py results; regenerate it with `.venv/bin/python web/test/make_reference.py` after changing the Python version.

## License

MIT. See [LICENSE](LICENSE).

The browser version bundles OpenCascade (via `replicad-opencascadejs`), which is licensed separately under the LGPL 2.1.

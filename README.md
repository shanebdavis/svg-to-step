# svg-to-step

**Try it in your browser: https://shanebdavis.github.io/svg-to-step/** (no install; your SVGs never leave your machine)

Turns an SVG into a flat, colored STEP model. Built for importing into Shapr3D and printing on a multi-material (tool-changer) printer.

There are two modes:

- **Puzzle** (default): full-height pieces set into a slab, described below.
- **Layers**: one layer per color, stacked in area order (largest or smallest first). Each layer covers its own color plus every color above it, so the bottom layer is solid and each color shows from the top at its own step height. With the slab on, the slab is the bottom layer.

Puzzle mode details:

- The SVG canvas (viewBox) becomes a gray slab with every painted shape cut out of it.
- Each visible, connected, single-color region becomes its own solid, colored to match the SVG. It fills its cutout exactly, with no clearance.
- Overlapping shapes resolve by paint order: pieces show exactly what the SVG renders.
- Curves stay true curves (circles, arcs, Beziers), not polygon facets.
- Optional base: a solid, single-color layer under the puzzle, with its own thickness. It covers the canvas, or with the slab off, follows the outline of the art with holes filled. Its color defaults to the SVG color with the most visible area; any other color in the model can be picked instead. A thin puzzle (two print layers, say) on a thick base keeps color changes to the top layers, so a multi-material print swaps filament only a couple of times per color.

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
- `--base`: puzzle mode, adds a base this many mm thick under the puzzle. The total height becomes base + height.
- `--base-color`: base color, default the SVG color with the most visible area.
- `--layer-thickness`: layers mode, fixed mm per layer. Default splits the height evenly. If layers × thickness exceeds the height, the model gets taller; if it falls short, the bottom layer takes the extra.
- `-o`: output path, default `art.step` next to the SVG.

## Limitations

- Only fills become geometry. Strokes are ignored; convert them to paths first (Inkscape: Path > Stroke to Path).
- `fill-rule` is treated as even-odd. A nonzero path whose subpaths overlap in the same direction (e.g. a self-intersecting star) gets holes where the browser shows fill.
- Gradients and patterns are not supported; use flat colors.

## GUI

Double-click `Start SVG to STEP.command` in Finder. The first run sets up the Python environment (about a minute). Close the Terminal window to stop the app. From a shell, `.venv/bin/python app.py` does the same.

It opens a local page at http://localhost:8765. Drop in an SVG, adjust size, height and slab color (or turn the slab off), add a base under a puzzle, and the 3D preview updates live. Settings are remembered between visits. "Explode" lifts pieces or layers apart to check the fit. Download STEP saves the current model.

## Browser version (web/)

A TypeScript rewrite that runs entirely in the browser: no server, no Python. It's live at https://shanebdavis.github.io/svg-to-step/, redeployed by GitHub Actions on every push to `main` after the tests pass. The CAD engine is the same OpenCascade kernel, compiled to WebAssembly (a ~7 MB gzipped download, cached after the first visit). It builds to static files that any web host can serve.

Double-click `Start SVG to STEP (Web).command`. It builds the app when the sources change (needs Node.js) and serves it at http://localhost:8775.

```sh
cd web
npm install
npm start        # development server, opens the browser
npm run serve    # production build, served at http://localhost:8775
npm test         # parity with svg2step.py, fill rules, SVG parsing, slab shapes, STEP and 3MF output
npm run build    # static site in web/dist
```

`web/dist` must be served over HTTP. Browsers block module scripts, workers and WebAssembly on pages opened from a file, so opening `dist/index.html` directly shows instructions instead of the app.

Differences from the Python version:

- `fill-rule` is honored: `nonzero` paths fill overlapping and self-intersecting areas the way browsers do.
- Elliptical arcs and non-uniformly scaled circles become Bezier curves; circles, circular arcs and ellipses stay exact.
- The slab can be the canvas or a square, circle or hexagon: the smallest one around the visible art, grown by a padding in mm.
- Download 3MF saves a Bambu Studio file: one object with a part per color, each on its own filament, with the colors stored for Bambu Studio to map onto your filaments.
- The last SVG is remembered along with the settings, so a reload picks up where you left off.

`web/test/reference.json` holds svg2step.py results; regenerate it with `.venv/bin/python web/test/make_reference.py` after changing the Python version.

## License

MIT. See [LICENSE](LICENSE).

The browser version bundles OpenCascade (via `replicad-opencascadejs`), which is licensed separately under the LGPL 2.1.

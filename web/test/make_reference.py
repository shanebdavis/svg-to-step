"""Record svg2step.py results as JSON, for the TypeScript parity tests.

Run from the repo root: .venv/bin/python web/test/make_reference.py

star.svg is left out: Python ignores fill-rule, which fill_rules.test.ts covers.
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from svg2step import build, parse_hex, to_hex  # noqa: E402

CASES = [
    {"mode": "puzzle", "slab": True},
    {"mode": "puzzle", "slab": False},
    {"mode": "layers", "order": "large", "slab": True},
    {"mode": "layers", "order": "small", "slab": False},
    {"mode": "layers", "order": "large", "slab": True, "layerThickness": 2.0},
    {"mode": "layers", "order": "large", "slab": False, "layerThickness": 1.0},
]
SIZE, HEIGHT = 150.0, 6.0


def summarize(model):
    by_group = defaultdict(float)
    for solid in model.children:
        by_group[f"{to_hex(tuple(solid.color)[:3])}@{solid.level}"] += solid.volume
    box = model.bounding_box()
    return {
        "solids": len(model.children),
        "volume": sum(s.volume for s in model.children),
        "groups": dict(sorted(by_group.items())),
        "volumes": sorted(s.volume for s in model.children),
        "size": [box.size.X, box.size.Y, box.size.Z],
    }


def main():
    results = {}
    for svg in sorted(p for p in (ROOT / "examples").glob("*.svg") if p.name != "star.svg"):
        for case in CASES:
            model, _ = build(
                svg, SIZE, HEIGHT, parse_hex("#808080") if case["slab"] else None,
                case["mode"], case.get("order", "large"), 0.5, case.get("layerThickness"),
            )
            results.setdefault(svg.name, []).append({"case": case, **summarize(model)})
            print(svg.name, case, len(model.children), "solids")
    out = Path(__file__).parent / "reference.json"
    out.write_text(json.dumps({"size": SIZE, "height": HEIGHT, "results": results}, indent=1))
    print("wrote", out)


if __name__ == "__main__":
    main()

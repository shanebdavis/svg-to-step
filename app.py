"""Local web GUI for svg2step: drop an SVG, tune size and height, preview in 3D, download STEP."""

import json
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from build123d import export_step

from svg2step import build, parse_hex, to_hex

PORT = 8765
HERE = Path(__file__).parent
build_lock = threading.Lock()  # OCCT and SkipClean are not thread safe
latest_step = {"name": "model.step", "data": b""}


def mesh(solid):
    """Triangles for display. Slivers can fail to mesh coarsely, so retry finer."""
    for tolerance in (0.05, 0.002):
        try:
            vertices, triangles = solid.tessellate(tolerance, 0.3)
            break
        except Exception:  # pylint: disable=broad-exception-caught
            continue
    else:
        return None
    return {
        "label": solid.label,
        "color": to_hex(tuple(solid.color)[:3]),
        "positions": [round(c, 4) for v in vertices for c in (v.X, v.Y, v.Z)],
        "indices": [i for tri in triangles for i in tri],
    }


def convert(params):
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False) as f:
        f.write(params["svg"])
    stem = Path(params.get("name") or "model").stem
    with build_lock:
        model, by_color = build(
            f.name, float(params["size"]), float(params["height"]),
            parse_hex(params["bgColor"]),
        )
        model.label = stem
        with tempfile.NamedTemporaryFile(suffix=".step", delete=False) as out:
            export_step(model, out.name)
        latest_step.update(name=f"{stem}.step", data=Path(out.name).read_bytes())
        meshes = [m for m in map(mesh, model.children) if m]
    size = model.bounding_box().size
    return {
        "meshes": meshes,
        "stats": {
            "solids": len(model.children),
            "colors": len(by_color),
            "size": [round(size.X, 2), round(size.Y, 2), round(size.Z, 2)],
        },
    }


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, content_type, headers=()):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for header in headers:
            self.send_header(*header)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/":
            self.send(200, (HERE / "app.html").read_bytes(), "text/html")
        elif self.path == "/model.step" and latest_step["data"]:
            disposition = f'attachment; filename="{latest_step["name"]}"'
            self.send(200, latest_step["data"], "application/step",
                      [("Content-Disposition", disposition)])
        else:
            self.send(404, b"not found", "text/plain")

    def do_POST(self):
        if self.path != "/convert":
            return self.send(404, b"not found", "text/plain")
        params = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        try:
            status, result = 200, convert(params)
        except Exception as error:  # pylint: disable=broad-exception-caught
            status, result = 500, {"error": f"{type(error).__name__}: {error}"}
        self.send(status, json.dumps(result).encode(), "application/json")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    url = f"http://localhost:{PORT}"
    print(f"svg2step GUI at {url}")
    threading.Timer(0.5, webbrowser.open, [url]).start()
    ThreadingHTTPServer(("localhost", PORT), Handler).serve_forever()

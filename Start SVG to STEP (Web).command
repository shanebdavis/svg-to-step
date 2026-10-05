#!/bin/zsh
# Double-click in Finder to run the browser-only version. Close this window to stop it.
cd "${0:A:h}/web"
URL=http://localhost:8775

if curl -s -o /dev/null "$URL"; then
  echo "Already running at $URL"
  open "$URL"
  exit 0
fi

# Rebuild when the build is missing or older than any source file.
if [ ! -f dist/index.html ] || [ -n "$(find src index.html package.json -newer dist/index.html 2>/dev/null | head -1)" ]; then
  if ! command -v npm >/dev/null; then
    echo "Node.js is needed to build the app (https://nodejs.org). Press Return to close."; read; exit 1
  fi
  echo "Building the web app..."
  { [ -d node_modules ] || npm install --no-fund --no-audit; } && npm run build || {
    echo "Build failed. Press Return to close."; read; exit 1
  }
fi

echo "SVG to STEP (web) at $URL"
(sleep 1 && open "$URL") &
exec python3 -m http.server 8775 --bind 127.0.0.1 --directory dist

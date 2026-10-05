#!/bin/zsh
# Double-click in Finder to launch the SVG to STEP GUI. Close this window to stop it.
cd "${0:A:h}"
URL=http://localhost:8765

if curl -s -o /dev/null "$URL"; then
  echo "Already running at $URL"
  open "$URL"
  exit 0
fi

if [ ! -x .venv/bin/python ]; then
  echo "First run: setting up Python environment (takes a minute)..."
  PYTHON=$(command -v python3.13 || command -v python3)
  "$PYTHON" -m venv .venv && .venv/bin/pip install -q --disable-pip-version-check -r requirements.txt || {
    echo "Setup failed. Press Return to close."; read; exit 1
  }
fi

exec .venv/bin/python app.py

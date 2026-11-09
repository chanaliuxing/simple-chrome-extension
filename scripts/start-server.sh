#!/usr/bin/env bash
# Start the local receiver service in the foreground.
# By default, runs in simple local mode (no pairing token required).
# Pass --extension-id <ID> to require pairing token if desired.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONPATH="$ROOT/server${PYTHONPATH:+:$PYTHONPATH}"

echo "Starting local Chrome extension receiver on http://127.0.0.1:18765..."
exec python3 "$ROOT/server/collector.py" serve "$@"

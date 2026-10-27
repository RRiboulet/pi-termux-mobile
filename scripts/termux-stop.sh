#!/usr/bin/env bash
# termux-stop.sh — stop the pi-mobile bridge.
#
# Usage:
#   bash scripts/termux-stop.sh

set -euo pipefail

STATE_DIR="${HOME:-/data/data/com.termux/files/home}/.pi-mobile"
PORT_FILE="$STATE_DIR/port"

# Find the bridge process
BRIDGE_PID=""
if [ -f "$PORT_FILE" ]; then
  PORT=$(cat "$PORT_FILE" 2>/dev/null || true)
  if [ -n "$PORT" ]; then
    BRIDGE_PID=$(pgrep -f "runtime/server.mjs" 2>/dev/null || true)
  fi
fi

# Also check by process name
if [ -z "$BRIDGE_PID" ]; then
  BRIDGE_PID=$(pgrep -f "server.mjs" 2>/dev/null || true)
fi

if [ -n "$BRIDGE_PID" ]; then
  echo "stopping bridge (PID: $BRIDGE_PID)..."
  kill -TERM $BRIDGE_PID 2>/dev/null || true
  # Wait for graceful shutdown
  for i in $(seq 1 10); do
    if ! kill -0 $BRIDGE_PID 2>/dev/null; then
      echo "bridge stopped"
      exit 0
    fi
    sleep 1
  done
  # Force kill if still running
  kill -KILL $BRIDGE_PID 2>/dev/null || true
  echo "bridge force-killed"
else
  echo "bridge is not running"
fi

# Release wake lock
if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock
  echo "wake lock released"
fi
EOF
chmod +x scripts/termux-stop.sh
#!/usr/bin/env bash
# termux-start.sh — start the pi-mobile bridge in Termux.
#
# Acquires a wake lock, starts the bridge with proper environment,
# and restarts it automatically if it crashes.
#
# Usage:
#   bash scripts/termux-start.sh
#   # or in background:
#   nohup bash scripts/termux-start.sh > ~/.pi-mobile/bridge.log 2>&1 &

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOME_DIR="${HOME:-/data/data/com.termux/files/home}"
STATE_DIR="$HOME_DIR/.pi-mobile"
LOG_FILE="$STATE_DIR/bridge.log"

mkdir -p "$STATE_DIR"

# Acquire wake lock to prevent CPU sleep
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  echo "wake lock acquired"
else
  echo "WARNING: termux-wake-lock not available. CPU may sleep."
fi

# Set environment
export HOME="$HOME_DIR"
export PI_WORKDIR="${PI_WORKDIR:-$REPO_DIR/work}"
export PI_SHELL="${PI_SHELL:-$(command -v bash || echo /bin/bash)}"

# Default to tailscale if available, otherwise lan
if [ -z "${PI_ACCESS:-}" ]; then
  if ip addr show tailscale0 >/dev/null 2>&1 || ip link show tailscale0 >/dev/null 2>&1; then
    export PI_ACCESS="tailscale"
  else
    export PI_ACCESS="local"
  fi
fi

echo "=== pi-mobile bridge ==="
echo "Repo: $REPO_DIR"
echo "Home: $HOME_DIR"
echo "Workdir: $PI_WORKDIR"
echo "Access: $PI_ACCESS"
echo "Log: $LOG_FILE"
echo ""

cd "$REPO_DIR"

# Watchdog loop: restart on crash
while true; do
  echo "[$(date -Iseconds)] starting bridge..." >> "$LOG_FILE"
  node runtime/server.mjs >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
  echo "[$(date -Iseconds)] bridge exited with code $EXIT_CODE" >> "$LOG_FILE"

  if [ "$EXIT_CODE" -eq 0 ]; then
    echo "bridge stopped cleanly"
    break
  fi

  echo "bridge crashed (exit $EXIT_CODE), restarting in 5s..."
  sleep 5
done
EOF
chmod +x scripts/termux-start.sh
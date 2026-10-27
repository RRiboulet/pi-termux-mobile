#!/usr/bin/env bash
# termux-boot.sh — auto-start pi-mobile on device boot.
#
# Install: copy this file to ~/.termux/boot/
#   mkdir -p ~/.termux/boot
#   cp scripts/termux-boot.sh ~/.termux/boot/pi-mobile.sh
#   chmod +x ~/.termux/boot/pi-mobile.sh
#
# Requires: Termux:Boot (from F-Droid)
#
# Usage: called automatically by Termux:Boot on device boot.

set -euo pipefail

# Wait for Termux to be ready
sleep 10

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# SCRIPT_DIR is ~/.termux/boot, so repo is at ~/pi-mobile
REPO_DIR="${HOME}/pi-mobile"

if [ ! -d "$REPO_DIR" ]; then
  echo "pi-mobile repo not found at $REPO_DIR" >> "$HOME/.pi-mobile/boot.log"
  exit 1
fi

# Start in background
nohup bash "$REPO_DIR/scripts/termux-start.sh" >> "$HOME/.pi-mobile/boot.log" 2>&1 &
EOF
chmod +x scripts/termux-boot.sh
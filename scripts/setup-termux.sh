#!/usr/bin/env bash
# setup-termux.sh — one-command bootstrap for pi-mobile on Termux.
#
# Installs dependencies, clones the repo (if not already present),
# installs runtime node_modules, and prepares everything for a first run.
#
# Usage:
#   bash scripts/setup-termux.sh
#   # or, from a fresh Termux:
#   curl -fsSL https://raw.githubusercontent.com/<user>/pi-termux-mobile/main/scripts/setup-termux.sh | bash

set -euo pipefail

REPO_URL="${PI_REPO_URL:-https://github.com/<user>/pi-termux-mobile.git}"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/pi-mobile}"

echo "=== pi-mobile Termux setup ==="

# 1. Update Termux packages
echo "--- updating Termux packages ---"
pkg update -y
pkg upgrade -y

# 2. Install dependencies
echo "--- installing dependencies ---"
pkg install -y nodejs git ripgrep termux-api termux-tools

# Verify Node version
NODE_VERSION=$(node --version)
echo "Node.js: $NODE_VERSION"
if [[ "$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)" -lt 22 ]]; then
  echo "ERROR: Node.js >= 22.19.0 required, got $NODE_VERSION"
  exit 1
fi

# 3. Clone or update repo
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "--- updating existing repo ---"
  cd "$INSTALL_DIR"
  git pull --ff-only
else
  echo "--- cloning repo ---"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# 4. Install runtime dependencies
echo "--- installing runtime dependencies ---"
cd "$INSTALL_DIR/runtime"
npm ci --omit=dev --omit=optional --ignore-scripts
cd "$INSTALL_DIR"

# 5. Create directories
mkdir -p "$HOME/.pi-mobile"
mkdir -p "$HOME/.pi/agent"
mkdir -p "$HOME/pi-mobile/work/extensions"

# 6. Set permissions
chmod +x "$INSTALL_DIR/scripts/"*.sh 2>/dev/null || true

echo ""
echo "=== setup complete ==="
echo "Install directory: $INSTALL_DIR"
echo ""
echo "To start the bridge:"
echo "  cd $INSTALL_DIR && bash scripts/termux-start.sh"
echo ""
echo "Then open a browser and go to:"
echo "  http://127.0.0.1:8787"
echo ""
echo "The bootstrap token will be printed on first run."
echo "Save it — you'll need it to sign in."

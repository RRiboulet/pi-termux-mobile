#!/usr/bin/env bash
# Set the container up for working on the app: the agent's identity, gh's
# token directory, the runtime's own dependencies, and the two paths Gradle
# needs that are gitignored and therefore absent from a fresh clone.
set -euo pipefail

REPO="${REPO:-/workspace}"
AGENT_DIR=/home/vscode/.pi/agent

# The Dockerfile sets GH_CONFIG_DIR as an image ENV, but a container built from
# an older image does not have it. Default it here to the same path so a bare
# `mkdir -p "$GH_CONFIG_DIR"` below cannot expand to `mkdir -p ""`, which fails
# under `set -e` and aborts the whole of postCreate before anything else runs.
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-/home/vscode/.pi/gh}"

# --- git identity ---
# Commit metadata is public the moment a branch is pushed: the author and
# committer addresses and every `Co-authored-by:` trailer live in the commit
# object, so a personal address there can only be removed by rewriting every
# branch and tag -- and even then it survives in forks and in GitHub's cached
# commit views. Pin the identity to the GitHub noreply address before any commit
# can be made.
#
# Applied here rather than in the Dockerfile because a personal identity does
# not belong in an image others may build; postCreate re-runs on every container
# creation, so ~/.gitconfig being container-local and discarded with
# /home/vscode does not matter.
git config --global user.name "RRiboulet"
git config --global user.email "122018936+RRiboulet@users.noreply.github.com"

# --- gh (GitHub CLI) ---
# The token is not in the image and never in git. It lives in the pi-config volume
# via GH_CONFIG_DIR (set in the Dockerfile), which is what makes one `gh auth login`
# last across rebuilds. Creating the directory here is all this needs to do; an
# unauthenticated gh is still useful (it reads public repos fine).
#
# sudo, and after the chown below: on a first-run volume the mount point
# inherits the image's root ownership, so a plain `mkdir -p` as vscode fails and
# `set -e` aborts postCreate before the chown that would have fixed it.
sudo chown -R vscode:vscode /home/vscode/.pi "$REPO"
mkdir -p "$GH_CONFIG_DIR" "$AGENT_DIR"

# --- the two gitignored paths Gradle needs ---
# `android/local.properties` is gitignored (it is a machine-local path), so a
# fresh clone has none and Gradle stops with "SDK location not found". The SDK
# lives on the pi-config volume at a fixed path, so the file can be written
# before the SDK is installed: the path does not have to exist yet.
SDK=/home/vscode/.pi/android-sdk
if [ ! -f "$REPO/android/local.properties" ]; then
	echo "sdk.dir=$SDK" > "$REPO/android/local.properties"
	echo "[postCreate] wrote android/local.properties (sdk.dir=$SDK)"
fi

# The runtime's own dependencies. `scripts/prepare-runtime.py` refuses to run
# without them, and the Gradle build runs that script before every build, so
# without this the first build in a fresh container stops with a message about
# a missing package rather than about a missing `npm ci`.
if [ ! -d "$REPO/runtime/node_modules/@earendil-works/pi-durable" ]; then
	echo "[postCreate] installing the runtime's dependencies (npm ci in runtime/)"
	(cd "$REPO/runtime" && npm ci --omit=dev --omit=optional --ignore-scripts)
fi

# The rootfs asset is gitignored too, and it is the slow one: the builder
# downloads the Termux packages, checks every one against the pinned index, and
# unpacks them. It is not run here -- a few minutes of download does not belong
# in container creation -- but its absence is reported, because the first build
# needs it and the reason it is missing is not obvious.
if [ ! -f "$REPO/android/app/src/main/assets/rootfs.bin" ]; then
	cat <<'MSG'

[postCreate] the rootfs asset is missing. The first build needs it, and it is
a one-time step that downloads the Termux packages:

    node scripts/package-rootfs.ts

MSG
fi

if ! gh auth status >/dev/null 2>&1; then
	cat <<'MSG'

gh is installed but not authenticated. One-time setup, in this terminal:

  gh auth login --hostname github.com --git-protocol https --web

It prints a one-time code and a URL: open the URL, paste the code, approve. The
token lands in the pi-config volume, so it survives a rebuild. Then run

Nothing else is needed: git's credential helper is configured system-wide in
the Dockerfile, so plain `git push` works in a fresh container without this.
MSG
fi

cat <<'MSG'

The app container is ready.

  node scripts/package-rootfs.ts     # once: the Termux rootfs asset
  cd android && ./gradlew assembleDebug

  npm test                           # the host-side checks
  ./scripts/device-smoke.sh          # the phone-only checks, with the phone attached

MSG

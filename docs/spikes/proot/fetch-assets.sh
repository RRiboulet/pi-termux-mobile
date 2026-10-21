#!/usr/bin/env bash
# Fetch the S0.1 runtime assets: proot (aarch64, from Termux) + a glibc rootfs
# (ubuntu-base arm64) + official Node arm64 (glibc, has node:sqlite).
#
# Every artefact is checked against assets/PINS.sha256, which is edited by hand.
# The Termux index is fetched to find where a package lives, but the PIN decides
# whether the version found is acceptable: if the index has moved to a newer
# proot, this stops and says so, because a new proot is a new pin -- it is the
# thing whose behaviour the spike exists to measure.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS="${ASSETS_DIR:-$HERE/../assets}"
PINS="$ASSETS/PINS.sha256"

[ -f "$PINS" ] || { echo "FATAL: $PINS is missing; the pins are the input contract" >&2; exit 1; }
mkdir -p "$ASSETS/debs" "$ASSETS/downloads"
cd "$ASSETS/downloads"

IDX="$ASSETS/downloads/Packages.gz"
BASE="https://packages.termux.dev/apt/termux-main"

echo "=== termux index ==="
curl -fsSL -o "$IDX" "$BASE/dists/stable/main/binary-aarch64/Packages.gz"
zcat "$IDX" > "$ASSETS/downloads/Packages.txt"

# The pool path of a package, from the index.
pool_path() {
    local pkg="$1"
    awk -v p="$pkg" '/^Package: /{pk=$2} pk==p && /^Filename: /{print $2; exit}' "$ASSETS/downloads/Packages.txt"
}

# Fetch a deb, but only the PINNED version of it.
fetch_deb() {
    local pkg="$1" pinned="$2" fname out
    fname="$(pool_path "$pkg")"
    if [ -z "$fname" ]; then
        echo "FATAL: $pkg is not in the Termux index any more" >&2
        exit 1
    fi
    if [ "$(basename "$fname")" != "$pinned" ]; then
        echo "FATAL: the Termux index now has $pkg as $(basename "$fname"), but the pin is $pinned." >&2
        echo "       A new proot is a new pin: review the change, then update assets/PINS.sha256" >&2
        exit 1
    fi
    out="$ASSETS/debs/$(basename "$fname")"
    if [ ! -f "$out" ]; then
        curl -fsSL -o "$out" "$BASE/$fname"
    fi
    echo "  got $(basename "$out")"
}

echo "=== proot + deps (Termux) ==="
fetch_deb proot            "proot_5.1.107.98_aarch64.deb"
fetch_deb libtalloc       "libtalloc_2.5.0_aarch64.deb"
fetch_deb libandroid-shmem "libandroid-shmem_0.7_aarch64.deb"

echo "=== ubuntu base arm64 ==="
UB=ubuntu-base-24.04.5-base-arm64.tar.gz
[ -f "$UB" ] || curl -fsSL -o "$UB" "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/$UB"

echo "=== node arm64 ==="
NV=v24.22.0
NF="node-$NV-linux-arm64.tar.xz"
[ -f "$NF" ] || curl -fsSL -o "$NF" "https://nodejs.org/dist/$NV/$NF"

echo "=== verify against the pins ==="
cd "$ASSETS"
sha256sum -c PINS.sha256

echo "ASSETS_OK"

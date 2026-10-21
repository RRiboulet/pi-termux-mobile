#!/usr/bin/env bash
# Build the S0.1 rootfs: a glibc Linux userland for proot to run.
#
# Shape:
#   ubuntu-base 24.04 (arm64)   - a minimal glibc userland
#   node 24.22.0 (arm64, glibc) - the JS runtime, which carries node:sqlite
#
# Glibc rather than bionic on purpose: the official Node arm64 binary is a
# glibc build, so a glibc rootfs is what lets us use an unmodified upstream
# Node. proot's job is to make the guest's dynamic loader and syscalls work
# against the host's bionic kernel.
#
# Output: tools/rootfs/rootfs.tar.gz  (gitignored: ~90 MB)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS="${ASSETS_DIR:-$HERE/../assets}"
OUT_DIR="$HERE/rootfs"
OUT_TAR="$OUT_DIR/rootfs.tar"
WORK="${WORK_DIR:-/tmp/pi-rootfs-build}"

NODE_VERSION="v24.22.0"
UBUNTU_BASE="ubuntu-base-24.04.5-base-arm64.tar.gz"
UBUNTU_URL="https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/${UBUNTU_BASE}"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-arm64.tar.xz"

echo "=== [1/5] fetch ==="
mkdir -p "$ASSETS/downloads"
cd "$ASSETS/downloads"
[ -f "$UBUNTU_BASE" ] || curl -fsSL -o "$UBUNTU_BASE" "$UBUNTU_URL"
[ -f "node-${NODE_VERSION}-linux-arm64.tar.xz" ] || \
  curl -fsSL -o "node-${NODE_VERSION}-linux-arm64.tar.xz" "$NODE_URL"
ls -la "$UBUNTU_BASE" "node-${NODE_VERSION}-linux-arm64.tar.xz"

echo "=== [2/5] unpack ubuntu-base ==="
rm -rf "$WORK"
mkdir -p "$WORK"
tar -xzf "$ASSETS/downloads/$UBUNTU_BASE" -C "$WORK"

echo "=== [3/5] unpack node into /usr/local ==="
tar -xJf "$ASSETS/downloads/node-${NODE_VERSION}-linux-arm64.tar.xz" -C "$WORK"
# Merge into the existing /usr/local. The old code moved the tree aside and only
# merged it back if it had no bin/ -- and the Node tarball always has one, so the
# merge never ran: node stayed at usr-local/ and the runner, which execs
# /usr/local/bin/node, found nothing.
mkdir -p "$WORK/usr/local"
cp -a "$WORK/node-${NODE_VERSION}-linux-arm64/." "$WORK/usr/local/"
rm -rf "$WORK/node-${NODE_VERSION}-linux-arm64"
# Trim what the kernel never needs. This only bites if the merge above put node
# under usr/local, which is why the post-condition below is not optional.
rm -rf "$WORK/usr/local/include" "$WORK/usr/local/share/doc" "$WORK/usr/local/share/man" \
       "$WORK/usr/local/share/info" "$WORK/usr/local/lib/node_modules/npm" \
       "$WORK/usr/local/lib/node_modules/corepack"
rm -f "$WORK/usr/local/bin/corepack" "$WORK/usr/local/bin/npx" "$WORK/usr/local/bin/npm"

# The post-condition: the guest must have exactly the binaries the runner is about
# to exec. A rootfs without them produces a report that says "node:sqlite is not
# available here" -- a false negative on the project's load-bearing unknown -- so
# this is a build failure, not a warning.
for required in usr/local/bin/node bin/sh; do
  [ -x "$WORK/$required" ] || { echo "FATAL: $required missing from the rootfs" >&2; exit 1; }
done

echo "=== [4/5] prepare the guest ==="
mkdir -p "$WORK/pi" "$WORK/spike" "$WORK/tmp" "$WORK/root"
chmod 1777 "$WORK/tmp"
# A minimal resolver stub: the spike is offline, but glibc's NSS wants the file
# to exist rather than crash.
printf 'nameserver 127.0.0.1\n' > "$WORK/etc/resolv.conf"
# The guest's own identity, so tools that ask "who am I" get a sane answer.
grep -q '^pi:' "$WORK/etc/passwd" 2>/dev/null || \
  printf 'pi:x:1000:1000:pi:/pi:/bin/sh\n' >> "$WORK/etc/passwd"
grep -q '^pi:' "$WORK/etc/group" 2>/dev/null || \
  printf 'pi:x:1000:\n' >> "$WORK/etc/group"
chmod 755 "$WORK" "$WORK/usr" "$WORK/usr/local" "$WORK/usr/local/bin" "$WORK/bin" "$WORK/lib"

echo "=== [5/5] pack ==="
mkdir -p "$OUT_DIR"
tar -cf "$OUT_TAR" -C "$WORK" .
ls -la "$OUT_TAR"
echo
echo "rootfs contents:"
tar -tf "$OUT_TAR" | grep -E '^\./(usr/local/bin/node|bin/sh|lib/ld)' | head -10
echo
echo "guest shell      : $(tar -tf "$OUT_TAR" | grep -cE '^\./usr/bin/sh$') (as /usr/bin/sh; /bin is a symlink to it)"
echo "guest node      : $(tar -tf "$OUT_TAR" | grep -cE '^\./usr/local/bin/node$')"
echo "longest path    : $(tar -tf "$OUT_TAR" | awk '{ if (length($0) > m) m = length($0) } END { print m }') chars"
echo "ROOTFS_OK"

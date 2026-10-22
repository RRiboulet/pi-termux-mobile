#!/usr/bin/env bash
# pair -> connect -> install -> smoke test, in one go.
#
#   ./pair-install.sh <pair-ip:port> <pair-code> <connect-ip:port>
#
# The pairing code expires in about a minute, so this retries the pair and then
# continues straight through to the install. The two ports differ and both come
# from the phone: the pairing one is inside the "Pair device with pairing code"
# dialog, the connect one is on the main Wireless debugging screen. The connect
# port rotates every time wireless debugging is toggled (find-adb-port.sh finds
# it); the pairing itself is remembered, so this only runs on a fresh pair.
#
# ADB and APK default to this repo's own toolchain and build output; override
# them for a devcontainer, where the toolchain lives outside the checkout:
#
#   ADB=~/android-sdk/platform-tools/adb ./pair-install.sh ...
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADB="${ADB:-$HERE/../tools/android-sdk/platform-tools/adb}"
REPO="${REPO:-$(cd "$HERE/.." && pwd)}"
APK="${APK:-$REPO/android/app/build/outputs/apk/debug/app-debug.apk}"

[ $# -eq 3 ] || { echo "usage: $0 <pair-ip:port> <pair-code> <connect-ip:port>" >&2; exit 2; }
[ -x "$ADB" ] || { echo "adb not found: $ADB" >&2; exit 1; }
[ -f "$APK" ] || { echo "APK not found: $APK (run ./gradlew assembleDebug first)" >&2; exit 1; }

PAIR="$1"; CODE="$2"; CONNECT="$3"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "pair $PAIR"
paired=0
for attempt in $(seq 1 12); do
    out="$("$ADB" pair "$PAIR" "$CODE" 2>&1 | tail -1)"
    echo "   attempt $attempt: $out"
    case "$out" in
        *Successfully*|*"paired to"*) paired=1; break ;;
    esac
    sleep 3
done
[ "$paired" = 1 ] || { echo "pairing never succeeded"; exit 1; }

say "connect $CONNECT"
connected=0
for attempt in $(seq 1 10); do
    out="$("$ADB" connect "$CONNECT" 2>&1 | tail -1)"
    echo "   attempt $attempt: $out"
    case "$out" in
        *connected*|*already*) connected=1; break ;;
    esac
    sleep 3
done
"$ADB" devices -l

say "install"
"$ADB" install -r "$APK"

say "smoke test"
cd "$REPO" && ./scripts/device-smoke.sh

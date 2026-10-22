#!/usr/bin/env bash
# pair -> connect -> install -> smoke test, in one go.
#
#   ./pair-install.sh <pair-ip:port> <pair-code> <connect-ip:port>
#
# The pairing code expires in about a minute, so this retries the pair and then
# continues straight through. The two ports differ and both come from the phone:
# the pairing one is inside the "Pair device with pairing code" dialog, the
# connect one is on the main Wireless debugging screen. The connect port rotates
# every time wireless debugging is toggled (find-adb-port.sh finds it); the
# pairing itself is remembered, so this only runs on a fresh pair.
#
# ADB, APK and REPO default to this repo's own toolchain and build output;
# override them for a devcontainer, where the toolchain lives outside the
# checkout:
#
#   ADB=~/android-sdk/platform-tools/adb ./pair-install.sh ...
#
# The connect is verified before anything is installed. `adb connect` can exit 0
# while leaving a stale/offline transport listed, and `adb install` with two
# rows fails with "more than one device" -- so the device is resolved by serial,
# and every later command is scoped to it with `-s`.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADB="${ADB:-$HERE/../tools/android-sdk/platform-tools/adb}"
REPO="${REPO:-$(cd "$HERE/.." && pwd)}"
APK="${APK:-$REPO/android/app/build/outputs/apk/debug/app-debug.apk}"

[ $# -eq 3 ] || { echo "usage: $0 <pair-ip:port> <pair-code> <connect-ip:port>" >&2; exit 2; }
[ -x "$ADB" ] || { echo "adb not found: $ADB" >&2; exit 1; }
[ -f "$APK" ] || { echo "APK not found: $APK (run ./gradlew assembleDebug first)" >&2; exit 1; }

# device-smoke.sh resolves adb from $ADB before falling back to ANDROID_HOME/PATH,
# so exporting it keeps the whole script on the toolchain it was given.
export ADB

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
for attempt in $(seq 1 10); do
    out="$("$ADB" connect "$CONNECT" 2>&1 | tail -1)"
    echo "   attempt $attempt: $out"
    # Resolve the state of THIS serial, not the presence of any device: the
    # success text alone does not prove the transport came up.
    DEV="$("$ADB" devices 2>/dev/null | awk -v t="$CONNECT" '$1 == t && $2 == "device" { print $1; exit }')"
    [ -n "$DEV" ] && break
    sleep 3
done

if [ -z "${DEV:-}" ]; then
    echo "$CONNECT never reached state 'device':" >&2
    "$ADB" devices -l >&2
    exit 1
fi
echo "   $DEV is up"

say "install + smoke test"
# device-smoke.sh installs the APK itself (that is its first step), so the
# install is not repeated here. It takes the serial as its argument.
"$REPO/scripts/device-smoke.sh" "$DEV"

#!/usr/bin/env bash
# Keep trying to attach to the phone, and log the moment the device state turns
# from "offline" to "device". Runs until it succeeds.
#
#   ./watch-adb.sh [connect-ip:port]
#
# The offline transport is the case this exists for: after a phone reboot or a
# wireless-debugging toggle, `adb devices` reports the old endpoint as
# "offline" and it never recovers on its own. Re-issuing disconnect/connect
# every fourth attempt refreshes the transport without spinning.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADB="${ADB:-$HERE/../tools/android-sdk/platform-tools/adb}"
CONNECT="${1:-${ADB_CONNECT:-}}"
IP="${PHONE_IP:-192.168.178.20}"
LOG="${LOG:-/tmp/adb-watch.log}"

[ -n "$CONNECT" ] || { echo "usage: $0 <connect-ip:port>  (or set ADB_CONNECT)" >&2; exit 2; }
[ -x "$ADB" ] || { echo "adb not found: $ADB" >&2; exit 1; }

: > "$LOG"

for i in $(seq 1 200); do
    state="$("$ADB" devices 2>/dev/null | sed -n '2p' | awk '{print $2}')"
    if [ "$state" = "device" ]; then
        echo "$(date +%T) ATTACHED after $i attempts" >> "$LOG"
        "$ADB" devices -l >> "$LOG" 2>&1
        cat "$LOG"
        exit 0
    fi
    # refresh the transport: a stale offline transport never recovers on its own
    if [ $((i % 4)) -eq 0 ]; then
        "$ADB" disconnect "$CONNECT" >/dev/null 2>&1
        "$ADB" connect "$CONNECT" >/dev/null 2>&1
    fi
    sleep 5
done
echo "$(date +%T) gave up (phone $IP)" >> "$LOG"
cat "$LOG"
exit 1

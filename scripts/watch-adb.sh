#!/usr/bin/env bash
# Keep trying to attach to the phone, and log the moment the endpoint under
# watch turns from "offline" to "device". Runs until it succeeds.
#
#   ./watch-adb.sh <connect-ip:port>
#
# The offline transport is the case this exists for: after a phone reboot or a
# wireless-debugging toggle, `adb devices` reports the old endpoint as
# "offline" and it never recovers on its own. Re-issuing disconnect/connect
# every fourth attempt refreshes it without spinning.
#
# It watches ONE endpoint, matched by serial. Reading the second row of
# `adb devices` instead would report success for any other attached device --
# a USB phone, an emulator, a stale endpoint -- while the one being waited for
# is still offline, which is exactly the state this script is used in.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADB="${ADB:-$HERE/../tools/android-sdk/platform-tools/adb}"
CONNECT="${1:-${ADB_CONNECT:-}}"
LOG="${LOG:-/tmp/adb-watch.log}"

[ -n "$CONNECT" ] || { echo "usage: $0 <connect-ip:port>  (or set ADB_CONNECT)" >&2; exit 2; }
[ -x "$ADB" ] || { echo "adb not found: $ADB" >&2; exit 1; }

: > "$LOG"

# The state of THIS serial, and nothing else. A serial that is absent from the
# list prints nothing, which is not "device".
state_of() {
	"$ADB" devices 2>/dev/null | awk -v t="$CONNECT" '$1 == t { print $2; exit }'
}

for i in $(seq 1 120); do
	state="$(state_of)"
	if [ "$state" = "device" ]; then
		echo "$(date +%T) ATTACHED after $i attempts" >> "$LOG"
		"$ADB" devices -l >> "$LOG" 2>&1
		cat "$LOG"
		exit 0
	fi
	# A fresh server prints its banner, which shifts the rows; harmless, the next
	# iteration reads again. `unauthorized` needs the phone's prompt, not a
	# reconnect, so it is left alone and simply keeps waiting.
	if [ $((i % 4)) -eq 0 ] && [ "$state" != "unauthorized" ]; then
		"$ADB" disconnect "$CONNECT" >/dev/null 2>&1 || true
		"$ADB" connect "$CONNECT" >/dev/null 2>&1 || true
	fi
	sleep 2
done
echo "$(date +%T) gave up waiting for $CONNECT (last state: ${state:-absent})" >> "$LOG"
cat "$LOG"
exit 1

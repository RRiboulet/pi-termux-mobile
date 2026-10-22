#!/usr/bin/env bash
# Find the phone's adb wireless port, gently.
#
#   ./find-adb-port.sh [phone-ip]
#
# The bound is the point. A 250-wide sweep over the full port range once spawned
# ~16,000 processes in a devcontainer whose PID 1 never reaps, and the container
# hit its process ceiling. This one:
#   - scans only 36000-47000, the range Android actually uses for adb wireless;
#   - caps concurrency at 16 with xargs -P, so at most 16 connections are ever in
#     flight, however long the scan takes * (each attempt costs ~3 short-lived
#     processes: xargs' child, timeout, bash);
#   - reaps its children through xargs, so killing this script leaves at most 16
#     orphaned processes, not thousands.
# Do not raise -P and do not widen the range.
#
# Every port that answers is reported, on stdout, once the scan finishes. The
# port rotates whenever wireless debugging is toggled or the phone reboots, so
# this is the step that repeats; pairing is remembered (see pair-install.sh).
set -uo pipefail

IP="${1:-${PHONE_IP:-192.168.178.20}}"
LOG="${LOG:-/tmp/adb-ports.log}"

# IP reaches /dev/tcp, and LOG reaches a redirect. Both are interpolated into a
# child shell, so both are validated: an unchecked PHONE_IP of
# "1.2.3.4; rm -rf ~" would otherwise be shell syntax, run once per port.
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "not an IPv4 address: $IP" >&2; exit 2; }
case "$LOG" in
	*"'"*|*'"'*|*'$'*|*'`'*|*';'*|*'&'*|*'|'*|*'<'*|*'>'*|*'('*|*')'*|*' '*)
		echo "LOG must be a plain path without quotes, spaces or shell metacharacters: $LOG" >&2
		exit 2 ;;
esac

: > "$LOG"
echo "scanning $IP for an open adb port (16 workers, 36000-47000)" > "$LOG"

# The address and the log travel through the environment rather than through the
# child's command string, so no value is ever parsed as shell syntax.
export SCAN_IP="$IP" SCAN_LOG="$LOG"
seq 36000 47000 | xargs -P 16 -n 1 bash -c '
	timeout 1 bash -c "exec 3<>/dev/tcp/$SCAN_IP/$1" 2>/dev/null && echo "$1" >> "$SCAN_LOG"
' _

echo "scan done" >> "$LOG"
cat "$LOG"

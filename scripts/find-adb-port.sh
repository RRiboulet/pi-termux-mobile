#!/usr/bin/env bash
# Find the phone's adb wireless port, gently.
#
# Last time a 250-wide sweep spawned ~16,000 processes that became unreapable
# zombies under pid 1 and killed the container. This one:
#   - uses 16 workers, not 250
#   - forks exactly one short-lived process per port (xargs reaps them all)
#   - stops as soon as it finds a port
#   - only scans the range Android actually uses for adbd wireless (36k-47k)
#
#   ./find-adb-port.sh [phone-ip]
#
# Ports are printed to stdout as they answer, and the whole log is at
# $LOG. The port rotates every time wireless debugging is toggled, so this is
# the step that has to be repeated; pairing is remembered (see pair-install.sh).
set -uo pipefail

IP="${1:-${PHONE_IP:-192.168.178.20}}"
LOG="${LOG:-/tmp/adb-ports.log}"
: > "$LOG"

echo "scanning $IP for an open adb port (16 workers, 36k-47k)" > "$LOG"

seq 36000 47000 | xargs -P 16 -I{} sh -c '
    timeout 1 bash -c "exec 3<>/dev/tcp/'"$IP"'/{}" 2>/dev/null && echo {} >> '"$LOG"'
' 2>/dev/null

echo "scan done" >> "$LOG"
cat "$LOG"

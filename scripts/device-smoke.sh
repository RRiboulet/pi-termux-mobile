#!/usr/bin/env bash
# Device smoke test: install the debug APK, wait for the bridge, and check the
# three things that are only provable on a real phone.
#
#   ./scripts/device-smoke.sh                 # the one attached device
#   ./scripts/device-smoke.sh <serial>
#
# What it checks:
#   1. the app installs, the service starts, and the bridge answers on loopback;
#   2. the node process is supervised -- kill -9 it and it comes back, with the
#      session intact (the durable store is what survives, not the process);
#   3. the store survives `am force-stop` and a relaunch.
#
# It needs a debuggable build (`assembleDebug`): `run-as` reads the app's own
# files. It does NOT need an API key: the prompt check is skipped when no
# provider key is set.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# awk on the quote character, not sed with a backreference: inside double quotes the shell
# eats the backslash and the expression fails outright.
PKG="$(awk -F"'" '/^[[:space:]]*applicationId/ {print $2; exit}' "$ROOT/android/app/build.gradle")"
APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
# An explicit $ADB wins, so a caller with its toolchain outside the checkout
# (a devcontainer) keeps the smoke test on the same adb it just used.
ADB="${ADB:-${ANDROID_HOME:-/opt/android-sdk}/platform-tools/adb}"
[ -x "$ADB" ] || ADB="$(command -v adb || true)"

SERIAL="${1:-}"
say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '   \033[31mFAIL\033[0m %s\n' "$*"; }
note() { printf '   ..   %s\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$ADB" ] && [ -x "$ADB" ] || die "adb not found (set ANDROID_HOME, or put adb on PATH)"
[ -f "$APK" ] || die "no APK: $APK -- run: cd android && ./gradlew assembleDebug"

sh_() { if [ -n "$SERIAL" ]; then "$ADB" -s "$SERIAL" "$@"; else "$ADB" "$@"; fi; }
# The app's own files, read as the app's uid.
app_cat() { sh_ shell run-as "$PKG" cat "files/$1" 2>/dev/null; }
# The pid of the bridge process, found by its command line.
# The node process, not the shell that is looking for it. The old version grepped every
# /proc/*/cmdline for "server.mjs" -- and the helper process running THIS script has that
# string in its own command line, so it found itself, killed its own shell, and reported a
# pass. It also walked the pids in lexicographic order, so a 4-digit helper sorted before a
# 3-digit node.
bridge_pid() {
    sh_ shell run-as "$PKG" sh -c \
        'for p in $(ls -d /proc/[0-9]* 2>/dev/null | sort -t/ -k3 -n); do
             [ -r "$p/cmdline" ] || continue
             [ "$(cat "$p/comm" 2>/dev/null)" = node ] || continue
             if tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -q server.mjs; then echo "${p##*/}"; break; fi
         done' \
        2>/dev/null | tr -d '\r' | head -1
}

say "device"
ATTACHED="$(sh_ devices | tail -n +2 | grep -w device | awk '{print $1}' | head -1)"
[ -n "$ATTACHED" ] || die "no device attached. Over USB: adb devices. Over the network: adb pair <host>:<port> && adb connect <phone-ip>:<port> (the app's own install-wifi.sh does this with mDNS)"
sh_ wait-for-device || die "no device"
[ -n "$SERIAL" ] || SERIAL="$ATTACHED"
note "serial $SERIAL   package $PKG   android $(sh_ shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')"

say "1. install"
sh_ install -r "$APK" >/dev/null 2>&1 && ok "installed" || die "adb install failed"
sh_ shell am start -n "$PKG/org.pimobile.app.MainActivity" >/dev/null 2>&1
note "started; the first launch extracts ~170 MB, which takes a few minutes"

say "2. wait for the bridge"
PORT=""
for _ in $(seq 1 120); do
    PORT="$(app_cat 'home/.pi-mobile/port' | tr -d '\r\n ')"
    [ -n "$PORT" ] && break
    sleep 5
done
[ -n "$PORT" ] || {
    bad "the bridge never came up"
    note "log/service-error.txt:"; sh_ shell run-as "$PKG" cat files/log/service-error.txt 2>/dev/null | tail -20
    note "log/node.log:";         sh_ shell run-as "$PKG" cat files/log/node.log 2>/dev/null | tail -20
    die "first launch did not reach a running bridge"
}
ok "bridge on 127.0.0.1:$PORT"

TOKEN="$(app_cat 'home/.pi-mobile/token' | tr -d '\r\n ')"
[ -n "$TOKEN" ] && ok "token read" || die "no token file"

# Make the phone's loopback reachable from here.
sh_ forward tcp:"$PORT" tcp:"$PORT" >/dev/null 2>&1
# The port is a parameter: the bridge binds an EPHEMERAL port, so the one read before the
# force-stop is not the one after it. Step 6 used to query the old port, which made the
# durability check a guaranteed false failure.
api() { curl -sS -m 20 -H "x-token: $TOKEN" "http://127.0.0.1:${2:-$PORT}$1"; }

say "3. the bridge answers"
STATE="$(api /api/state)"
[ -n "$STATE" ] && ok "GET /api/state" || { bad "GET /api/state: $STATE"; die "the bridge does not answer"; }
MODELS="$(api /api/models)"
if printf '%s' "$MODELS" | grep -q '"' ; then ok "GET /api/models"; else note "GET /api/models: $MODELS"; fi

say "4. the store is there"
if command -v sqlite3 >/dev/null 2>&1; then
    sh_ shell run-as "$PKG" sh -c 'ls -l files/home/.pi-mobile/*.sqlite 2>/dev/null' | sed 's/^/   /'
else
    sh_ shell run-as "$PKG" sh -c 'ls files/home/.pi-mobile/ 2>/dev/null' | sed 's/^/   /'
fi

say "5. the bridge is supervised (kill -9 and it comes back)"
PID="$(bridge_pid)"
if [ -z "$PID" ]; then
    bad "could not find the bridge pid"
else
    note "bridge pid $PID"
    sh_ shell run-as "$PKG" sh -c "kill -9 $PID" >/dev/null 2>&1
    note "killed; waiting for the supervisor"
    BACK=""
    for _ in $(seq 1 24); do
        sleep 5
        NEW="$(bridge_pid)"
        if [ -n "$NEW" ] && [ "$NEW" != "$PID" ]; then BACK="$NEW"; break; fi
    done
    if [ -n "$BACK" ]; then
        ok "the supervisor restarted it: $PID -> $BACK"
        sleep 3
        [ -n "$(api /api/state)" ] && ok "the bridge answers again" || bad "the bridge does not answer after the restart"
    else
        bad "the bridge did not come back within 2 minutes"
        note "log/node.log:"; sh_ shell run-as "$PKG" cat files/log/node.log 2>/dev/null | tail -20
    fi
fi

say "6. the store survives force-stop"
sh_ shell am force-stop "$PKG" >/dev/null 2>&1
note "force-stopped; relaunching"
sleep 2
sh_ shell am start -n "$PKG/org.pimobile.app.MainActivity" >/dev/null 2>&1
PORT2=""
for _ in $(seq 1 60); do
    PORT2="$(app_cat 'home/.pi-mobile/port' | tr -d '\r\n ')"
    [ -n "$PORT2" ] && break
    sleep 5
done
if [ -n "$PORT2" ]; then
    ok "the bridge is back on 127.0.0.1:$PORT2"
    sh_ forward tcp:"$PORT2" tcp:"$PORT2" >/dev/null 2>&1
    TOKEN="$(app_cat 'home/.pi-mobile/token' | tr -d '\r\n ')"
    [ -n "$(api /api/state "$PORT2")" ] && ok "and it answers" || bad "and it does not answer"
else
    bad "the bridge did not come back after force-stop"
fi

say "done"
note "the app is at http://127.0.0.1:$PORT2 on the phone -- forward that port to open it in a desktop browser"
note "a prompt needs a provider key: the app's API keys page, or ~/.pi/agent/auth.json on the phone"

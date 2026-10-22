#!/bin/sh
# A live check of the install gate.
#
# It boots the bridge the way the phone does (a temporary HOME, the test
# model, no network), has the agent propose an extension, approves the hash
# that was shown, and asks the model to call the new tool. Then it restarts
# the bridge and asks again.
#
# The check matches a UNIQUE MARKER per request. The attach-time frame of the
# event stream is the previous transcript, so a check that looks for "the tool
# ran" finds the turn before it and passes even when nothing was installed.
#
# There is a negative control: before the install, the same call has to fail
# with "demo_echo is not available" — which says both that the message was
# well formed and that the tool was genuinely not there. A check that cannot
# fail is not a check.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
export HOME="$TMP/home"
export PI_WORKDIR="$TMP/home/work"
export TMPDIR="$TMP"
export PI_SHELL=/bin/bash
export PREFIX="$TMP/prefix"
export PI_TEST_FAUX=1
export PI_PROVIDER=faux
export PI_MODEL=faux-1
mkdir -p "$HOME" "$PI_WORKDIR" "$PREFIX"

EXT='export default {
  name: "demo",
  tools: [{
    name: "demo_echo",
    description: "Echo a word back.",
    parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
    execute: async (args) => ({ content: [{ type: "text", text: "echo: " + args.word }] }),
  }],
};'

say() { printf '\n=== %s ===\n' "$1"; }

start() {
  node "$ROOT/runtime/server.mjs" >> "$TMP/server.log" 2>&1 &
  SERVER=$!
  for i in $(seq 1 80); do
    [ -f "$HOME/.pi-mobile/port" ] && break
    sleep 0.5
  done
  PORT=$(cat "$HOME/.pi-mobile/port" 2>/dev/null || true)
  [ -n "$PORT" ] || { echo "FAIL: the bridge did not start"; cat "$TMP/server.log"; exit 1; }
  TOKEN=$(cat "$HOME/.pi-mobile/token")
  API="http://127.0.0.1:$PORT"
}
stop() {
  kill "$SERVER" 2>/dev/null || true
  wait "$SERVER" 2>/dev/null || true
  rm -f "$HOME/.pi-mobile/port"
}
trap 'stop 2>/dev/null || true; rm -rf "$TMP"' EXIT

# ask_the_model <marker> <tool> <json-args> <expect>
#
# The model calls <tool> with <json-args>, and the stream has to contain
# <expect>. For the echo tool that is "echo: <marker>"; for the control it is
# the "tool is not available" error, which names the tool that was missing.
ask_the_model() {
  node -e '
const [api, token, marker, tool, args, expect] = process.argv.slice(1);
const post = { message: `!tool ${tool} ${args}`, requestId: marker };
const res = await fetch(`${api}/api/prompt`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-token": token },
  body: JSON.stringify(post),
});
if (!res.ok) { console.error("prompt failed:", res.status); process.exit(2); }
const stream = await fetch(`${api}/api/events?token=${encodeURIComponent(token)}`);
const reader = stream.body.getReader();
const dec = new TextDecoder();
let buf = "";
const timer = setTimeout(() => reader.cancel().catch(() => {}), 20000);
try {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // The marker only appears in the turn this prompt caused.
    if (buf.includes(expect)) break;
  }
} finally {
  clearTimeout(timer);
  await reader.cancel().catch(() => {});
}
const hit = buf.includes(expect);
console.log(hit ? `saw: ${expect}` : `did not see: ${expect}`);
if (!hit) {
  console.log("--- the stream said ---");
  console.log(buf.slice(-1200));
}
process.exit(hit ? 0 : 1);
' "$API" "$TOKEN" "$1" "$2" "$3" "$4"
}

say "the agent writes a proposal"
mkdir -p "$PI_WORKDIR/extensions"
printf '%s\n' "$EXT" > "$PI_WORKDIR/extensions/demo.mjs"
start

say "the agent proposes it"
ask_the_model "marker-propose" "extension_propose" '{"file":"demo.mjs"}' "demo.mjs is proposed"

say "the proposal is waiting, with its hash and its diff"
curl -s -H "x-token: $TOKEN" "$API/api/extensions" | head -c 300; echo

say "the negative control: the tool is NOT there yet"
ask_the_model "marker-before-install" "demo_echo" '{"word":"marker-before-install"}' \
  "Tool demo_echo is not available"

say "the user approves the hash it was shown"
HASH=$(curl -s -H "x-token: $TOKEN" "$API/api/extensions" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).proposals[0].hash))')
curl -s -H "x-token: $TOKEN" -H 'content-type: application/json' \
  -d "{\"key\":\"demo.mjs\",\"hash\":\"$HASH\"}" "$API/api/extensions/install"; echo

say "the tool is there for the model, with no restart"
ask_the_model "marker-after-install" "demo_echo" '{"word":"marker-after-install"}' \
  "echo: marker-after-install"

say "a file that changed since the approval is refused"
echo "// changed" >> "$PI_WORKDIR/extensions/demo.mjs"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -H "x-token: $TOKEN" -H 'content-type: application/json' \
  -d "{\"key\":\"demo.mjs\",\"hash\":\"$HASH\"}" "$API/api/extensions/install")
echo "status $STATUS"
[ "$STATUS" = "409" ] || { echo "FAIL: a changed file was not refused"; exit 1; }

say "the bridge restarts: the approved extension comes back"
stop
printf '%s\n' "$EXT" > "$PI_WORKDIR/extensions/demo.mjs"
start
curl -s -H "x-token: $TOKEN" "$API/api/extensions" | head -c 200; echo

say "and the tool is there again, after the restart"
ask_the_model "marker-after-restart" "demo_echo" '{"word":"marker-after-restart"}' \
  "echo: marker-after-restart"

say "the server log"
cat "$TMP/server.log"
echo
echo "the gate works"

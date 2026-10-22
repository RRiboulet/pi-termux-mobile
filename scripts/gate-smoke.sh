#!/bin/sh
# A live check of the install gate: boot the bridge the way the phone does,
# propose an extension, approve it, and see that (a) the tool is there for the
# model straight away, and (b) a restart keeps it.
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
stop() { kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true; rm -f "$HOME/.pi-mobile/port"; }
trap 'stop 2>/dev/null || true; rm -rf "$TMP"' EXIT

say() { printf '\n=== %s ===\n' "$1"; }

say "the agent writes a proposal"
mkdir -p "$PI_WORKDIR/extensions"
printf '%s\n' "$EXT" > "$PI_WORKDIR/extensions/demo.mjs"
start

say "the proposal is waiting, with its hash and its diff"
curl -s -H "x-token: $TOKEN" "$API/api/extensions" | head -c 400; echo

say "the user approves the hash it was shown"
HASH=$(curl -s -H "x-token: $TOKEN" "$API/api/extensions" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).proposals[0].hash))')
curl -s -H "x-token: $TOKEN" -H 'content-type: application/json' \
  -d "{\"key\":\"demo.mjs\",\"hash\":\"$HASH\"}" "$API/api/extensions/install"; echo

say "the tool is there for the model, with no restart"
curl -s -H "x-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"message":"!tool demo_echo {\"word\":\"hello\"}","requestId":"r1"}' "$API/api/prompt"; echo
sleep 4
curl -s -H "x-token: $TOKEN" "$API/api/state" > /dev/null
# the transcript lives in the snapshot the SSE stream sends; the entries are in
# the durable store, so read them back through the state route's sibling:
curl -s -H "x-token: $TOKEN" "$API/api/usage" > /dev/null
node -e '
const url = process.argv[1];
const res = await fetch(url + "/api/events?token=" + process.argv[2]);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
const timer = setTimeout(() => { reader.cancel(); }, 6000);
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  if (buf.includes("tool said:")) break;
}
clearTimeout(timer);
const m = /tool said: ([^"\\]*)/.exec(buf);
console.log(m ? "the tool ran: " + m[1] : "NO TOOL RESULT in the stream");
process.exit(m ? 0 : 1);
' "$API" "$TOKEN"

say "a file that changed since the approval is refused"
echo "// changed" >> "$PI_WORKDIR/extensions/demo.mjs"
curl -s -o /dev/null -w 'status %{http_code}\n' -H "x-token: $TOKEN" -H 'content-type: application/json' \
  -d "{\"key\":\"demo.mjs\",\"hash\":\"$HASH\"}" "$API/api/extensions/install"

say "the bridge restarts: the approved extension comes back"
stop
printf '%s\n' "$EXT" > "$PI_WORKDIR/extensions/demo.mjs"
start
curl -s -H "x-token: $TOKEN" "$API/api/extensions" | head -c 300; echo
say "and the tool is there again, after the restart"
curl -s -H "x-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"message":"!tool demo_echo {\"word\":\"again\"}","requestId":"r2"}' "$API/api/prompt"; echo
sleep 4
node -e '
const url = process.argv[1];
const res = await fetch(url + "/api/events?token=" + process.argv[2]);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
const timer = setTimeout(() => { reader.cancel(); }, 6000);
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  if (buf.includes("tool said:")) break;
}
clearTimeout(timer);
const m = /tool said: ([^"\\]*)/.exec(buf);
console.log(m ? "the tool ran: " + m[1] : "NO TOOL RESULT in the stream");
process.exit(m ? 0 : 1);
' "$API" "$TOKEN"

say "the server log"
cat "$TMP/server.log"

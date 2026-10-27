# Next steps — hand-off

*Started 2026-10-24 at `dev@4f673bf`; updated 2026-10-27 at `dev@fc0591b`
(items 1–3, 6, 8 done; the notification's code half landed in #32; #33–#36 added
device auth, the access file, restore docs and per-client sessions). Written at
the end of a long session that got expensive; the "paying less" section is the
point of half this file.*

## Where things stand

- **`dev` is green**, and gated: `.github/workflows/tests.yml` runs
  `node scripts/run-tests.mjs` — 18 test files — on every push to `dev` and every
  pull request. It does not build the APK (item 9).
- **The phone runs pi mobile** (package `app.pidabl`, label "pi mobile"). The
  bridge is on `127.0.0.1:8787` and the served client is current: `app.js` and
  `style.css` from the bridge hash-match `runtime/public/` at `dev`'s tip
  (`fc0591b`); `index.html` differs only by the `?v=<mtime>` cache-busters the
  bridge adds. The **server** was hand-copied too; the APK's Java half is older,
  and installing a different APK wipes `files/runtime` (HOME and WORK survive).
- **The bridge is on a stable port: `127.0.0.1:8787`** (8788–8791, then
  ephemeral). The WebView's origin is that port, so a bridge restart reconnects in
  place instead of stranding the page on a dead URL. Live since 2026-10-24 12:54.
  `pistatus` still scans `32768–60999` and cannot see 8787 — probe 8787 directly
  or read `files/home/.pi-mobile/port` (only via `adb shell run-as`; Termux cannot
  run `run-as` itself).

## The queue

Ordered by value per unit of work. One item per session.

1. ~~**Put the token bill on screen.**~~ Done: per-model `in · cached · out`
   and money in the Usage sheet, and a `compact` pill in the composer past 60% of
   the window.
2. ~~**A log view.**~~ Done: `GET /api/log?file=node|service&tail=N`, a Log sheet,
   and the service log no longer records exit 0 as a failure (that half is Java and
   ships with the next APK).
3. ~~**Stuck-state audit of the client.**~~ Done: one toast for every notice,
   `connecting…` instead of a false `idle`, and a "Reload client" row in the menu.
4. **A notification when a turn finishes.** Code merged (#32), **needs a
   build**: the bridge writes `$HOME/.pi-mobile/status.json` (`state`, `tool`,
   `session`, `finishedAt`) from the kernel's own event stream — no client
   needed — and PiService polls it to put `working · <tool>` in the ongoing
   notification and to post "pi finished" when a turn ends with the app in the
   background (`MainActivity` reports `appVisible`).
   `test/status-e2e.test.mjs` covers the bridge half; the Java half is
   unverified until it compiles, which is item 9.
5. **Attachments.** Images and files from the phone. Biggest item here: check
   what pi-durable accepts as content before designing the UI.
6. ~~**CI.**~~ Done: `.github/workflows/tests.yml`, green on `dev` and on pull
   requests. It does not build the APK — that is item 9.
7. **Store size.** Nothing ever deletes rows; the store is 15 MB with 22
   conversations and 4,556 entries and only grows. Two routes: a "purge archived
   sessions" maintenance command (SQL in one transaction, forced backup first,
   `VACUUM` after), or upstream a conversation-delete in the kernel.
8. ~~**Document restore.**~~ Done: `docs/backup-and-restore.md`, and
   `test/restore-e2e.test.mjs` runs the procedure (back up, kill, delete the
   database, extract, boot, check) so the document cannot rot. It also made the
   archive's layout a contract: paths inside are relative to `$HOME`.
9. **Prove the APK path.** `prepare-runtime.py` + `gradlew` in the devcontainer,
   then boot it. `test/packaging.test.mjs` only proves the *list*; a real build is
   the only thing that proves the payload.
10. **Visual coverage.** The client tests are linkedom: structure and text, no
    layout, no touch, no CSS. Everything the user reported by eye this week (a
    pulsing dot, a bar that would not reset) was invisible to the suite.

## Facts that cost hours — do not rediscover them

- **Client deploy** = copy into `files/runtime/public/`. Live after a page load,
  and a page load happens only in `MainActivity.onCreate`: **Back out of the app
  and relaunch**. Force stop kills the bridge *and* the agent session.
- **Server deploy** = copy the `.mjs` into `files/runtime/`, then
  `pkill -f 'files/runtime/server.mjs'`; PiService restarts node in ~1 s. It ends
  a running turn, so do it with nothing in flight.
- The Activity never reloads on resume, and the served page names its assets by
  mtime (`app.js?v=…`), which is why a stale page can no longer masquerade as a
  deployed fix.
- `scripts/prepare-runtime.py` packages an explicit `FILES` list.
  `test/packaging.test.mjs` guards it: a module missing from that list is a dead
  bridge on the phone (`ERR_MODULE_NOT_FOUND` at boot).
- **There is no conversation delete**, in the app or in pi-durable. Archiving is a
  flag in the `app.sessions` document; the transcript stays. Nothing in the app
  deletes rows, not even "Reset this conversation" (it appends a reset marker).
- **Usage is per assistant message**: `entries.record.model[].usage` with
  `timestamp` (ms). The `pi.usage` document is a cumulative ledger per
  (conversation, model) and has no timestamps. Session 7992 reached 746 entries /
  1.87 MB / ~380k tokens of prefix per call.
- `files/log/service-error.txt` logs normal stops as errors — read it with that in
  mind.
- The debug keystore lives in the devcontainer. A fresh container cannot update an
  installed APK → uninstall → HOME is gone → **back up first**.

## Done since this was written

Device sign-in and access modes (#33/#35, `docs/access.md`): hashed per-device
tokens, an HttpOnly cookie, one-time pairing codes, rotation, and
`PI_ACCESS=local|tailscale|lan` with a Host allow-list. The allow-list can also
come from `access.json`, `hostname.json`, `host.json` or `hosts.json`, not only
`PI_HOSTNAME`.

Per-client active sessions (#36): `client-sessions.json` maps each device to its
conversation, a device without one falls back to `bootstrap`, and a session
picked on a laptop no longer drags the phone — the ongoing notification follows
the phone's own (bootstrap) session. The old global `active` remains the final
fallback.

## Paying less

A session's cost is its prefix × its tool rounds; both are under your control.

- **One task per session.** Start fresh, and compact (menu → Compact context) once
  the context passes ~150k. Do not continue a 1.8 MB session to save a minute.
- **Read narrowly:** `rg -n` for locations, `sed -n 'a,bp'` for the region. Never
  `cat` a large file. Pipe long output through `head`/`tail`, or write it to a file
  and grep that.
- **Never paste a whole diff or a whole log into the conversation** — it stays in
  the prefix for every later call. `git diff --stat`, then the hunks you need.
- **Test the file you touched** (`node scripts/run-tests.mjs client`) while
  iterating; the full suite once before a push (≈2 min, most of it `sse-stall`). A
  DOM test is ~50 ms; each e2e bridge boot is ~6–8 s.
- **One PR per concern**: branch off `dev`, tests in the same commit, merge with a
  merge commit. Leave nothing half-pushed.

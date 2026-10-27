# Device verification

The runtime has been run on a real phone. This is what was checked, and what
it means for the parts of the design that were still open questions.

## The device

| | |
|---|---|
| Model | Samsung Galaxy S21 Ultra (`SM-G998B`) |
| Android | 15 (API 35), build `AP3A.240905.015.A2` |
| Kernel | `5.4.242-30958140-abG998BXXSJHZC2` |
| Arch | aarch64 |
| Build | `app.pidabl`, debug (so `adb shell run-as` works) |
| targetSdk | 28 |

## What was proven

- **The app installs and launches.** `am start` resolves
  `app.pidabl/org.pimobile.app.MainActivity`; the system installer takes the
  APK straight from `/storage/emulated/0/Download/`.
- **The runtime extracts and `node` execs out of the app-private prefix.**
  This is the one the whole design rested on: the Termux binaries are
  extracted to `files/usr` and executed from there, under SELinux, as the
  app's own uid. It works.
- **The durable harness starts.** The bridge serves the app's web UI on the
  phone's loopback (`GET /` -> 200 with the app's own HTML), and
  `GET /api/state` -> 401, so the bearer token is enforced. The harness
  opening the store happens before the server listens, so **`node:sqlite`
  works on Android** — that was the open sub-question in the plan's R1.
- **The service restarts the bridge.** The port was ephemeral at the time:
  after the app was stopped and reopened, the bridge came back on a
  *different* port (38351 -> 38337) and answered immediately. Nothing was
  left half-installed. (It prefers 8787 now; see the re-check above.)
- **The first launch is slow, and that is expected.** ~170 MB extracts into
  app-private storage; the bridge only starts once that is done.

## Re-check, 2026-10-27

The app recorded above is still installed and has been usable for days. This
check was made over ssh (the tailnet route; the LAN address works too):

- **The bridge is up on the stable port.** `GET http://127.0.0.1:8787/` → 200
  with `<title>pi</title>`; `GET /api/state` → 401, so the token is still
  enforced. That is the preferred port in `runtime/server.mjs`
  (`8787..8791`, then ephemeral), not the ephemeral one from 2026-10-13.
- **The served client is current.** `app.js` and `style.css` fetched from the
  bridge hash-match `runtime/public/` at `dev`'s tip (`fc0591b`); `index.html`
  is the same file with the bridge's `?v=<mtime>` cache-busters added.
- **The app is not directly inspectable from Termux.** `pm path`/`dumpsys` are
  filtered or denied for another app's uid, `ss` shows no listeners, and
  `run-as` cannot be executed from Termux at all (SELinux). The bridge is the
  reliable probe; the store and supervisor checks below still need `adb shell
  run-as` on a debuggable build.
- **`pistatus` cannot find this bridge.** It scans `32768–60999`, and 8787 is
  below that range. Use `curl 127.0.0.1:8787/` or read
  `files/home/.pi-mobile/port`.

The "port is ephemeral" observation below is what was true on 2026-10-13; the
bridge has preferred 8787 since 2026-10-24.

## How it was checked, without a working adb

Wireless debugging would not complete the handshake — adbd accepted the TCP
connection and closed it (`connection terminated: read failed`), which is what
happens when the device is waiting for a human to approve the debugging
session. The phone's own Termux sshd was reachable on the LAN, which was
enough:

- the APK was pushed with `scp` to `/storage/emulated/0/Download/` (96 MB in
  3.6 s) and its SHA-256 verified on the phone;
- `pistatus` (in the phone's Termux) finds the bridge by scanning the
  phone's own loopback for the port that answers with the app's HTML, and
  reports what the API says.

`pistatus` is the quickest way to ask the phone what state the app is in:

```bash
ssh -p 8022 <phone> 'pistatus'
```

(At the time — the helper scans `32768–60999` and no longer finds the bridge,
which prefers 8787; see the re-check above.)

## Still unproven

The 2026-10-27 re-check does not close either item: the app is usable, but
neither a `kill -9` of `node` nor an interrupted tool call was exercised.

- **The supervisor's restart of a killed `node`.** The service restarted the
  bridge when the app was stopped and reopened, but the interesting case —
  `node` dying while the service lives, and the supervisor bringing it back —
  needs `kill -9` on the process, which needs a working adb channel.
- **The durable store across a `kill -9`.** The session survived a normal
  restart, which is the same code path, but the interrupted-tool-call
  semantics (an `interrupted` diagnostic rather than a rerun) are the
  plan's M0.3/M0.4 fixtures and have not been exercised on a device.

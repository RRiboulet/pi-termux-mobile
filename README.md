# pi-termux-mobile

> **Experimental software:** This is a personal prototype under active
> development. The embedded Termux runtime and Android background-process
> handling may still change or fail on individual devices.
>
> **Version 0.0.5** — still quick & dirty, see the [changelog](#changelog).

Minimal Android app that embeds Termux-built binaries (Node.js 26.4.0, bash,
coreutils, git, ripgrep, fd, npm, …) plus a **pi-durable** harness
(`@earendil-works/pi-durable` 1.0.3 + pi-ai/chord) behind a tiny HTTP/SSE
bridge (`runtime/server.mjs`). UI is a local WebView on
`http://127.0.0.1:<port>` (ephemeral port → `files/home/.pi-mobile/port`,
token → `…/token`).

The durable harness gives: SQLite-backed conversations
(`files/home/.pi-mobile/harness.sqlite` — survive process death,
`harness.resume()` continues interrupted runs), a `subagent` tool (child
conversations owned by the calling task), model selection per conversation,
and per-conversation execution environments.

This app runs **only on the phone**: there is no remote-host, terminal or
federation subsystem left. See [What was removed](#what-was-removed).

## This fork

This repository is now **pidabl** — a phone-native Pi Durable agent, and the
only project of the two that runs on a phone.

What changed here, and why, is written down in
[`docs/`](docs/README.md):

- **[`docs/plan-revision.md`](docs/plan-revision.md)** — the plan this app came
  out of, and what changed when it moved to this lineage. **Start here.**
- **[`docs/device-verification.md`](docs/device-verification.md)** — what was
  actually run on a Galaxy S21 Ultra (Android 15).
- **[`docs/reviews/ui-review.md`](docs/reviews/ui-review.md)** — the client
  review, and the defects it found.
- **[`docs/gh-tool.md`](docs/gh-tool.md)** — `scripts/gh`, the small GitHub CLI
  this fork uses to open pull requests for other agents to review.
- **[`docs/pi-durable-android-plan.md`](docs/pi-durable-android-plan.md)** —
  the original plan, kept because it explains why the app looks the way it does.

The shape of the app is unchanged from upstream: a foreground service owns the
runtime, the WebView is a passive view over a loopback bridge, and the client
has **no build step** — so the file the agent edits on the phone is the file
that runs.

## The agent setup is a shared package

The pi extensions and skills are **not vendored here**. They come from the
shared package declared in [`.pi/settings.json`](.pi/settings.json):

```json
{
  "packages": ["git:github.com/RRiboulet/my-agent-setup@v1.9.0"]
}
```

The same way `RRiboulet/analytics-agent` does it. `pi` clones the package
into `.pi/git/` (gitignored) and loads it for this project, so working on the
app from a checkout gives the same tools — subagent, todos, the review
triage, the skills — as working on the setup itself, and there is one home
for that code rather than two. Because project packages need project trust,
pi loads them only after the project is trusted.

Bump the pin when a release of the shared setup comes out, the way
`analytics-agent` did.

## The app

One screen: the conversation, a status line and a composer. Everything else is
a sheet that slides up from the **☰** menu or the model button in the top bar.

- **Model** — the model picker, with the thinking levels the chosen model
  actually supports. Tap the model button in the top bar to open it.
- **Thinking** — the reasoning level of the current model.
- **Provider** — API keys and OAuth/subscription sign-in. Credentials are
  stored as `~/.pi/agent/auth.json` in pi CLI format. Select an OAuth provider
  under **OAuth / subscription**, then choose **sign in**; when a provider
  offers several methods the app asks which one (browser login, device code).
  Browser flows open in the Android browser and return through the app's
  loopback callback; device flows show the verification URL and code in the
  app. A finished credential is available to the model picker immediately.
- **Sessions** — the local durable sessions: open one, or start a new one.
- **Usage** — tokens and cost, this session and everything so far.

Plus **New session**, **Reset this conversation**, **Compact context** and
**Update pi**.

### Your own models

The app reads `~/.pi/agent/models.json`, the same file the pi CLI reads, and
layers the models in it over the bundled catalog. A model the provider offers
but the bundled catalog does not know is added this way:

```json
{
  "providers": {
    "opencode-go": {
      "models": [
        {
          "id": "minimax-m3.1-flash-free",
          "name": "MiniMax M3.1 Flash Free",
          "api": "anthropic-messages",
          "baseUrl": "https://opencode.ai/zen/go",
          "reasoning": true,
          "thinkingLevelMap": { "off": null, "minimal": "low", "max": "max" },
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 1000000,
          "maxTokens": 512000
        }
      ]
    }
  }
}
```

A `models` entry adds or replaces one model by id; the provider's other models
stay. `api` and `baseUrl` are filled in from the provider's own models when
they are left out, exactly as the CLI does. A file that does not parse, or an
entry that cannot describe a model, is ignored — it never costs the phone its
models. The file is read when the bridge starts.

## Extensions

The agent can write code for the kernel. That code is a **proposal**: the
agent writes the extension and calls `extension_propose`, and the whole file,
its sha256 and its diff appear in the menu's **Extensions** sheet. Nothing
runs until you tap **Install**. The hash you were shown is the hash that is
approved, and the bytes that are imported are the bytes that were hashed, so
a file that changed in the meantime is refused rather than installed. A
proposal cannot take over the app's own extensions or tools.

The install is hot: the tool is in the next turn's tool list, with no restart
and no lost session, and the kernel's extensions come back after a bridge
restart — unless the file changed while it was down.

An extension is **not sandboxed**. It runs inside the bridge process, with
the bridge's permissions, and the agent can read the bridge's token. The gate
is an accident guardrail — it makes you look at the code before it runs — and
not a boundary: the agent has `bash`, and it can already edit the bridge's
own source. What the gate does is make the ordinary path — write an
extension, propose it — need a tap.
[docs/install-gate.md](docs/install-gate.md) has the details, including where
this falls short of the plan's §5 R10.

## App screen

<img src="docs/screens/chat.png" width="260" alt="Chat page">

Local conversation running on the phone (durable: SQLite-backed, survives
process death), with model dropdown, session name, token/cost counter and
new / compact buttons.

## What was removed

The multi-page client (Remote, pi CLI, Clients, Accounts, Sessions, Spaces)
was replaced by the single-screen client in `42bc8cc6`. The server-side
subsystems those pages used were kept for a while after the pages were gone;
they are now removed as well:

| Removed | Was |
|---|---|
| `runtime/pi-serverd.mjs`, `runtime/remote-*.mjs`, `runtime/env-server.mjs` | attaching to durable sessions on other machines over SSH, and running tools on them |
| `runtime/pi-spaces.mjs` (704 KB), `runtime/spaces-mobile.mjs`, `runtime/space-keystore.mjs` | the federation/spaces service |
| the `/pty` WebSocket and the util-linux `script` PTY | the embedded pi TUI |
| `/api/remote/*`, `/api/clients`, `/api/sshkey`, `/api/spaces/*` | the endpoints of those pages |
| `/api/sessions/{rename,delete,fork}`, `/api/result`, `/api/pi-version`, `/api/pi-update-status` | endpoints the current client never calls |
| `@earendil-works/pi-coding-agent`, `pi-client`, `pi-server`, `ws`, `xterm` (~46 MB of `node_modules`) | the CLI, the tunnel client, the host daemon, the PTY |

They are not lost: the `feature/remote-subsystem` branch and the
`pre-prune-2026-10-21` tag still have them, and
`git checkout feature/remote-subsystem -- runtime/remote-client.mjs` brings a
file back.

## Layout

- `android/` — Gradle project (app module, Java only, no NDK)
- `runtime/` — `server.mjs` (durable bridge: the HTTP/SSE API and the static
  client), `common.mjs` (harness setup, credential store with file lock,
  durable session registry, single-owner lock),
  `models-config.mjs` (the reader for `~/.pi/agent/models.json`),
  `node-bin.mjs` (the node binary to spawn: on Android `process.execPath` is
  the dynamic linker, not node),
  `gate.mjs` (the install gate: the agent's proposals, the user's approval),
  `public/` (the single-screen client), package.json for prod node_modules
- `scripts/` — `package-rootfs.ts` (builds `rootfs.bin` from the Termux
  index), `prepare-runtime.py` (packages `runtime.bin` + `payload.sha256`),
  `run-tests.mjs` (runs the test files, on the phone as well as on a host),
  `gate-smoke.sh` (the install gate, against a live bridge),
  `gh`/`gh.mjs` (a small GitHub CLI)
- `tools/` — local toolchain (JDK 21, Android SDK, Gradle 8.10.2) — not committed
- `.devcontainer/` — the container this app is worked on in: the JDK, the
  Android SDK (installed onto the `pi-agent-config` volume, not baked into
  the image), and the setup Gradle needs

## Build

The container in [`.devcontainer/`](.devcontainer/) has the toolchain: JDK 17,
the Android SDK, Node, python3, tmux and gh. Open this repository in it and
the build below works as written.

From a clean checkout:

```bash
node scripts/package-rootfs.ts            # assets/rootfs.bin  (once, or after changing the package list)
cd runtime && npm ci --omit=dev --omit=optional --ignore-scripts && cd ..
cd android
JAVA_HOME=<path-to>/tools/jdk21 ./gradlew assembleDebug   # or the container's JDK 17
# APK: app/build/outputs/apk/debug/app-debug.apk (~96 MB, aarch64 only content)
```

`package-rootfs.ts` needs Linux with `dpkg`, `dpkg-deb`, GNU `tar` and
`gzip`, and a Node that can run `.ts` directly — type stripping is on by
default from 22.18 and 23.6, and the runtime already asks for >= 22.19. It
refuses to start without the tools, rather than failing 200 MB in.

The Termux index is pinned in `scripts/termux-index.lock`: the per-package
SHA-256 is read from the same index the packages come from, so it proves
index/deb consistency and not index authenticity. The lock makes the index
moving a reviewed diff instead of a silent upgrade of the binaries inside
the APK. When the index moves, the builder stops and says what changed; to
take it, review it and run `node scripts/package-rootfs.ts
--update-index-lock`. Verifying Termux's own signature over the index (a
pinned key) is the remaining gap.

`gradlew` runs `scripts/prepare-runtime.py` before `preBuild`, so
`runtime.bin` and `payload.sha256` are rebuilt on every build.

An incremental build can leave the APK ~25 MB larger than its contents
(106 MB of assets in a 131 MB file) because the previous archive is not
rewritten from scratch. Delete `android/app/build` before measuring or
shipping an APK.

Toolchain notes:

- JDK 21 (Temurin) — Gradle/AGP 8.7.3 does not support the system JDK 25.
- compileSdk 35, minSdk 26, targetSdk **28** — keeps direct `execve()` of
  app-private binaries working (Android 10+ SELinux blocks it for
  targetSdk >= 29). `PiService` falls back to launching node via
  `/system/bin/linker64` if direct exec ever fails, so targetSdk can be raised.
- Asset fingerprints automatically trigger re-extraction when the runtime or rootfs changes.
  `RUNTIME_VERSION` in `RuntimeInstaller.java` covers installer behavior changes. An upgrade replaces `usr/` and `runtime/` entirely
  (archives are streamed into tar); `home/` and `work/` are kept.

## Tests

```bash
npm test                       # every test/*.test.mjs
node scripts/run-tests.mjs client   # only the files whose name matches
node test/node-bin.test.mjs     # one file, on its own
bash scripts/gate-smoke.sh      # the install gate, against a live bridge
```

`scripts/gate-smoke.sh` boots the bridge the way the phone does (a temporary
`HOME`, the test model, no network), proposes an extension, approves the hash
it was shown, asks the model to call the new tool, and restarts the bridge to
check the tool is still there. It is the one check that needs a running
server, so it is a script and not a test file.

The tests run **on the phone**, which is the point of them: the file the
agent edits on the phone is the file that runs, so the checks that guard it
have to run there too.

`scripts/run-tests.mjs` exists because `node --test` cannot run here. Node's
own runner spawns one child process per test file using `process.execPath`,
and on Android `process.execPath` is the **dynamic linker**, not node:
termux-exec re-execs every process through the linker, so `/proc/self/exe` is
the linker and Node reports that as `process.execPath`. The run dies before
the first test:

```
error: expected absolute path: "--test-concurrency=0"
```

(that message is the linker complaining about the flag it was handed). The
runner spawns the files itself, with the node binary resolved by
`runtime/node-bin.mjs`: `process.argv0`, which is the program that was asked
to run in every launch mode, and which is never the linker.

## Repackaging assets

Every Android build runs `scripts/prepare-runtime.py` before `preBuild`. It packages `runtime.bin`
and generates `payload.sha256` for the runtime/rootfs pair. Changed payloads are re-extracted on the
device without a manual version bump. Unchanged files keep their timestamps.

Build prerequisites: Python 3, installed mobile runtime dependencies and the prepared rootfs asset.

```bash
# 1. the Termux userland the app runs -> assets/rootfs.bin (a few minutes, ~81 MB)
node scripts/package-rootfs.ts

# 2. the mobile runtime + the payload fingerprint (also performed by Gradle):
python3 scripts/prepare-runtime.py
```

`scripts/package-rootfs.ts` resolves the aarch64 Termux index, checks every
.deb against its SHA-256, extracts it without maintainer scripts, and rewrites
the prefix `/data/data/com.termux` to `/data/data/<applicationId>` in place.
The rewrite patches the same offset, so **the applicationId must be exactly
as long as `com.termux`** — ten characters. The script reads it from
`android/app/build.gradle` and refuses to run otherwise.

`prepare-runtime.py` omits node_modules/.bin and broken links from the archive
without deleting local files. (.bin suffix because aapt decompresses *.gz
assets into the APK uncompressed. `RuntimeInstaller` tolerates tar's non-zero
exit when the expected payload files are present — bad-symlink warnings are
only logged.)

The rootfs builder is deterministic: the same index gives the same
`rootfs.bin` byte for byte, so `payload.sha256` only changes when the package
set really changed and the device does not re-extract 200 MB for nothing. It
prunes `usr/include`, `usr/share/man`, `usr/share/info` and
`usr/libexec/installed-tests`, and it keeps `usr/share/doc` and
`usr/share/LICENSES` — the licence texts and the per-package notices of the
binaries this APK redistributes.

## Install / run

```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
# or wireless: ./install-wifi.sh (pairs via mDNS, installs, starts)
```

The package id is `app.pidabl`, so an install over an older
`org.pimobile.app` build fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`:
uninstall the old one first. The app's data directory moves with the package
id, so `home/` (the provider keys, the sessions) does not come across. The id
is not free to change afterwards either — the Termux binaries carry it
compiled in, and `scripts/package-rootfs.ts` has to rewrite it.

**Verified on a real phone** — a Samsung Galaxy S21 Ultra on Android 15:
the runtime extracts, `node` execs out of the app-private prefix, the durable
harness starts, `node:sqlite` opens the store, and the service brings the
bridge back after a restart. What was checked, and what is still unproven, is
in [docs/device-verification.md](docs/device-verification.md).

`scripts/device-smoke.sh` installs the debug APK on the attached device and
checks the three things only a real phone can show: that the bridge comes up
and answers on loopback, that the supervisor restarts the node process when
it is killed, and that the store survives `am force-stop`. It needs a
debuggable build (`assembleDebug`), because it reads the app's own files with
`run-as`.

First launch extracts ~170 MB to app-private storage, then a foreground
service starts `node runtime/server.mjs`. The service runs exactly one bridge:
reopening the app attaches to the running one instead of restarting it, a
crashed bridge is restarted with backoff, and stopping sends SIGTERM so the
harness closes cleanly. `server.mjs` holds `~/.pi-mobile/server.lock`
(pi-durable allows one storage owner) and stops an orphaned predecessor. Open the app → **☰** → **Provider** to
store a provider key or sign in through OAuth, then prompt. Local conversation state lives in
`files/home/.pi-mobile/harness.sqlite` and survives process death. The session
registry and the active session are a pi-durable document in the same
database (an old `sessions.json` is imported once), so a restart reopens the
session that was active. The chat streams answers, shows tool output (tap a
tool line), subagent children, usage, and offers *steer* while a run is busy;
every prompt carries a `requestId` so retries are exactly-once.

Caveats on device:

- MIUI kills the process aggressively in the background (foreground works
  fine): Settings → Apps → pi mobile → battery saver "no restrictions" +
  autostart.
- Android 12+: phantom-process killer may kill node/bash subprocesses;
  workaround needs `adb shell settings put global
  settings_enable_monitor_phantom_procs false` or the Android 14+ developer
  option. Foreground service + PARTIAL_WAKE_LOCK are held while running.
- The bundle's shebangs and compiled-in paths were rewritten to this app's
  package id by `scripts/package-rootfs.ts`, so `npm` and the other scripts
  find their interpreter. The Android *package* names inside Termux's own
  tools (`am`, `pkg`, `termux-*`) still say `com.termux`; they are dead here.

See ANALYSE.md for the full evaluation and upstream facts.

## Changelog

### Unreleased — pruned to a phone-only app

The multi-page client was replaced by the single-screen one in `42bc8cc6`;
the server-side subsystems behind the removed pages are gone now too. See
[What was removed](#what-was-removed). The remote/SSH subsystem is parked on
the `feature/remote-subsystem` branch, not lost.

Added: `~/.pi/agent/models.json` is read by the bridge, so a model the
bundled catalog does not know can be added without touching the app.

Added: **the install gate.** An extension the agent writes is a proposal, not
an install: the agent calls `extension_propose`, and the whole file, its
sha256 and its diff appear in the menu's **Extensions** sheet. Nothing runs
until the user taps **Install**. The hash that is shown is the hash that is
approved, and the bytes that are imported are the bytes that were hashed, so
a file that changed in the meantime is refused rather than installed. A
proposal cannot take over the app's own extensions or tools. The install is
hot — the tool is in the next turn's tool list, with no restart and no lost
session — and the kernel's extensions come back after a bridge restart,
unless the file changed while it was down. See
[docs/install-gate.md](docs/install-gate.md). This is an accident guardrail,
not a boundary: an extension runs inside the bridge process, with the
bridge's permissions, and the agent can read the bridge's token — it can
already edit the bridge's own source. What the gate does is make the
ordinary path, write an extension and propose it, need a tap.

Fixed: the node binary to spawn. `process.execPath` is the dynamic linker on
Android — termux-exec re-execs every process through it, and `PiService` has
the same fallback for the app-home exec ban — and the linker cannot run a
JavaScript file. Spawning it failed with `has bad ELF magic`, which broke
**Update pi** on the phone, and broke `node --test` everywhere on the phone,
so the test suite could not be run where the code runs.
`runtime/node-bin.mjs` resolves the binary from `process.argv0` instead, and
`scripts/run-tests.mjs` runs the test files itself. See [Tests](#tests).

### 0.0.5 — 2026-10-05

New UI design, pi update in the app, remote session rename, and various fixes.

**UI redesign**

- Hamburger menu replaced by a **bottom tab bar** (Chat · Remote · CLI · Clients · Keys).
- On the Terminal page a **≡ slide-up sheet** replaces the menu.
- Chat header: inline **＋ / ⇊ / ■** buttons (new session, compact, abort).
- Session name in the Chat header links to the Sessions page.
- Remote page: two-row connect bar — host + connect/disconnect on the first row,
  session dropdown + ✎ ＋ ✕ ■ ⇊ on the second row.
- **stop server** button next to connect: ends `pi-serverd` on the selected host
  (with or without an active connection); the next connect restarts/updates it.
- Host selection no longer auto-connects; the user clicks **connect** explicitly.
- Cards, status dots, section headers throughout; CSS custom properties for theming.

**pi update in the app (Accounts page)**

- Shows the installed pi version and checks npm for a newer release.
- **Update** button runs `npm install @earendil-works/*@latest` directly on the
  phone (via `node npm-cli.js`, bypassing the Termux shebang issue).
- npm install uses `--ignore-scripts` to skip esbuild postinstall failures on Android.
- Progress streams line by line; on failure the npm output and error are shown.
- Bridge restarts automatically after a successful update.

**Remote: session rename**

- Added **✎** rename button on the Remote session row.
- `pi-serverd.mjs` now handles the `sessions.rename` member of the sessions service.

**Fixes**

- Remote connect bar no longer auto-connects on host dropdown change.
- `npm install` on the phone now uses `node npm-cli.js` instead of the Termux
  shell-script npm wrapper (which has a Termux-specific shebang and fails in-app).
- Status code `2` (tar/npm exit code) no longer crashes the HTTP server.
- Node >= 22.19.0 required (matches upstream `pi-coding-agent` / `pi-durable`).

**Dependencies**

- All `@earendil-works/*` packages bumped to `^1.0.3` in `package.json`.

### 0.0.4 — 2026-10-05

- **pi CLI (ssh):** compares `pi --version` with the current npm release before
  starting. A newer `@earendil-works/pi-coding-agent` is installed to `~/.local`.
  Registry-check and update failures leave the installed pi usable.

### 0.0.3 — 2026-10-05

Hardening and correctness pass for remote provisioning.

- Enforces the upstream Node engine requirement **>= 22.19.0** (rather than
  accepting every Node 22 release).
- `auth.json` is copied only after explicit SSH fingerprint verification and
  the red credential warning. The saved fingerprint is checked again server-side.
- Release updates are staged first, switched atomically, and roll back on a
  failed start. PID-targeted shutdown replaces global `pkill`.
- A live socket is additionally verified through `sessions.list`; unhealthy
  daemons are restarted.
- Failed `ssh-copy-id` no longer silently proceeds to reconnect.
- Cancelling a Remote connection invalidates an in-flight provisioning result.
- Adds basic Node-version, target-validation and release-hash tests.

### 0.0.2 — 2026-10-05

Hosts are now prepared automatically when connecting remotely. Details:
[Remote host setup](#remote-host-setup-automatic).

**Remote host setup**

- **pi-serverd installation.** Connecting from the Remote page checks the host
  over SSH; without a running daemon the server files are copied to
  `~/.pi-mobile-remote/runtime`, dependencies installed (`npm ci --omit=dev`) and
  the daemon started in the tmux session `pi-serverd`. tmux is installed if
  possible (root or `sudo -n`), otherwise `nohup setsid` is used. The progress
  log appears in the Remote page.
- **Version check and update.** A hash over the server files decides whether the
  daemon on the host is outdated; updating restarts it and asks first.
  `npm ci` only runs when the package files changed.
- **pi installation.** *pi CLI (ssh)* and *Clients → ▸_* install the latest
  `@earendil-works/pi-coding-agent` into `~/.local` when `pi` is missing and npm
  exists.
- **auth.json.** A host without `~/.pi/agent/auth.json` gets the phone's file
  only after a red warning dialog and consent (mode 600). Without credentials the
  remote daemon answered every prompt with *Internal server error*.
- **SSH key.** A host that rejects the phone's key offers `ssh-copy-id` in the
  terminal and then reconnects (Remote page) or continues (terminal).
- **Node from version managers.** Remote commands source nvm/fnm/Volta/asdf paths;
  Node installed through them was reported as missing before.
- The Remote page connect button turns into **disconnect** while connected.

**Fixes**

- The terminal registered another key handler on every reconnect, which would
  send input twice.

**Notes**

- Node.js >= 22.19.0 + npm on the host are still required and are not installed.
- `RUNTIME_VERSION` 45; the new `remote-provision.mjs` is part of the runtime
  archive (see *Repackaging assets*).

### 0.0.1 — 2026-10-04

Lots of bugfixes around durable sessions, security and the Android service.

**Security**

- Remote attach tunnels a unix socket in the app-private directory
  (`ssh -L local.sock:remote.sock`) instead of a loopback TCP port that every
  app on the phone could reach — pi-server does not authenticate peers.
- An unauthenticated request for a directory (e.g. `GET /vendor`) no longer
  crashes the bridge (unhandled `EISDIR`); static serving is confined to
  `public/`.
- Host-header check against DNS rebinding, constant-time token comparison,
  request body limit, token removed from the visible URL/history.
- SSH targets are validated (`user@host[:port]`); option-like targets such as
  `-oProxyCommand=…` are rejected, `--` is passed before the host.
- `env-server.mjs` binds `127.0.0.1` by default, requires a token of at least
  16 characters, compares it in constant time and limits body size.
- `pi-serverd` keeps its state directory at `0700` and its socket at `0600`.
- `auth.json` is written atomically under a lock file (bridge and pi-serverd),
  so a concurrent OAuth refresh cannot lose a rotated refresh token.
- Cleartext HTTP is allowed only for `127.0.0.1`/`localhost`
  (network security config instead of `usesCleartextTraffic`).
- The remote host key fingerprint is shown on connect (trust on first use).

**Durable sessions**

- The selected model is no longer overwritten before every prompt and on every
  remote attach (the code read `viewState().value.agent`, which does not exist;
  agent choices live in `docs['pi.agent']`). `busy` is derived from
  `docs['pi.live'].run`.
- Prompts carry a client-generated `requestId`: retries after a dropped
  connection are exactly-once.
- Every SSE client gets its own `watchEvents()` stream, so a reconnecting chat
  shows the current state instead of the snapshot from when the session was
  opened; pi-durable's `snapshot` and `agent_changed` events are handled.
- Remote events are sequence-numbered with an epoch: several clients can read
  one session, a lost response is fetched again, and a client that fell behind
  or saw a daemon restart reloads the transcript.
- A dropped remote tunnel is rebuilt with backoff and the session re-attached.
- The session registry and the active session are a pi-durable document in
  the same SQLite database, written in the same commit as the conversation;
  old `sessions.json` files are imported once. The active session survives a
  restart.
- Deleting a session aborts its running work first.
- The subagent tool returns the child's answer again (the child handle has no
  `commit()`); its child conversation is shown in the transcript.
- One storage owner: `server.mjs`/`pi-serverd.mjs` take a lock file and stop an
  orphaned predecessor; both close the harness on `SIGTERM`.

**Android**

- Opening the app no longer restarts the running bridge (which interrupted
  running tool calls and briefly opened the database twice). The service runs
  exactly one node process, restarts it with backoff if it dies, and stops it
  with `SIGTERM` + grace period.
- One non-reference-counted wake lock instead of one per start.
- Runtime archives are streamed into `tar` (no temporary 170 MB copy); an
  upgrade replaces `usr/` and `runtime/` completely, user data in `home/` and
  `work/` is kept. `RUNTIME_VERSION` 43.
- Node log rotation; longer first-start wait in the WebView.

**UI**

- Answers stream live (the old code expected a non-existent event shape),
  tool output can be expanded, subagent children and usage/cost are shown.
- *Steer* while a run is busy, *Compact context*, fork and rename sessions,
  remote abort/compact and a reconnect status.
- Shared transcript renderer for local and remote chat, deduplicated by entry
  id; generic `.hidden` CSS rule (remote controls were never hidden).

**Other**

- `env-server`: streamed output (NDJSON); aborting a tool call kills the
  command's whole process group. Remotes can be configured in
  `~/.pi-mobile/remotes.json`.
- Shared `runtime/common.mjs` for both servers; `PI_TEST_FAUX=1` provides a
  scripted offline model for tests.
- `start_server.sh` now actually passes `PI_WORKDIR` to pi-serverd (it was set
  as an unexported shell variable).

## Device test report (0.0.1)

Tested on 2026-10-04, upgrading an installed 0.1.0 build (runtime 42) in place. Remote host: Fedora with OpenSSH, reached over Wi-Fi with the phone's Termux OpenSSH.

| Test | Result |
|---|---|
| Upgrade runtime 42 → 43 | ✅ toybox `tar` reads from stdin, done in ~13 s; `usr/` and `runtime/` replaced, credentials and sessions kept |
| Legacy `sessions.json` | ✅ imported into the durable registry; "Main" and the active session kept |
| `GET /vendor`, foreign `Host`, missing token | ✅ bridge keeps running / 421 / 401 |
| Model choice + real prompt | ✅ `claude-haiku-4-5` stays selected after the prompt, answer "pong" |
| Same `requestId` sent twice | ✅ one submission |
| Activity recreated 3× (`onCreate`) | ✅ node keeps the same PID, no bridge restart |
| Agent kills its own bridge during a bash call | ✅ supervisor restarts node after ~1 s, `resume()` continues the run, bash returns `interrupted`, the model answers |
| WebView UI | ✅ loads over `127.0.0.1` with the network security config; tool line, usage and menu work |
| Remote over Termux OpenSSH | ✅ tunnel socket `0600` in a `0700` directory, host key fingerprint matches the host, daemon socket `0600` |
| Phone's sshd session killed | ✅ status `reconnecting`, reconnected after ~2 s, retried prompt runs exactly once |
| Remote page in the app | ✅ host selected, session attached with full history, model and usage shown |

Not tested on the device: the service's own `SIGTERM` stop path
(`onDestroy`), which cannot be triggered from outside for a non-exported
service.

---

*vibe coding fun with pi* — [Earendil Pi on GitHub](https://github.com/earendil-works/pi)

---

### Removed after this report

The Spaces page, the federation runtime and the **Spaces-Steuerung** page
(`runtime/public/steuerung.html`) were removed when the server was pruned to a
phone-only app; `PI_SERVERD_FEDERATION_CONFIG`, the Android Keystore device
key, `node --test test/spaces-mobile.test.mjs` and the `pi-spaces` sibling
repository's operational documents went with them. The prose above is left as
the record of what the 0.0.1 report measured. The code is in
`feature/remote-subsystem` and in the `pre-prune-2026-10-21` tag.

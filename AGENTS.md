# Agent Notes

This repository is the **phone-native Pi Durable agent**: an Android
foreground service runs a Node bridge, and a WebView client talks to it over
loopback. The app is `app.pidabl`.

Read [`docs/plan-revision.md`](docs/plan-revision.md) before planning
anything: the plan was written for a different runtime, and the revision says
what changed and why. [`docs/README.md`](docs/README.md) indexes the rest.

## The two things that are easy to get wrong

**The client has no build step.** `runtime/public/` is plain ES modules, and
the bridge serves it with `cache-control: no-store`. So *the file the agent
edits on the phone is the file that runs* — there is no bundler, no
transpile, no "build the client" step. That is the whole reason the app can
be changed from the phone, and any change that introduces a build step
breaks the property the project is reaching for.

**The kernel is pi-durable, not the desktop pi.** The runtime ships
`@earendil-works/pi-durable` 1.0.3, `pi-ai` and `chord`. The coding agent,
its TUI, the PTY, the tunnel client and the host daemon were all removed on
purpose (see the README's "What was removed"), and the client speaks
pi-pocket's SSE contract. Do not reach for `@earendil-works/pi-coding-agent`
here: it is not a runtime dependency, and adding it back would put ~46 MB
into the APK for a component the phone never runs.

## Branches

| Branch | What lands on it |
|---|---|
| `dev` | all work in flight. Every feature branch starts here. |
| `master` | the upstream-shaped line: what jeamy's fork looked like before the prune. |

`dev` is the phone-only lineage and `master` is the pre-prune one; they
diverge deliberately, and upstream (`jeamy/pi-termux-mobile`, the `upstream`
remote) has commits of its own that this fork does not want.

**Start a feature branch from `dev`.** Pull requests target `dev` with an
explicit `--base dev`: this repository's default branch is `master`, so
`gh pr create --fill` without it opens the pull request against `master`.
Merges are **squash**, and the branch is deleted afterwards — a squash does
not put the branch tip in `dev`'s history, so `git branch -d` would refuse it
without `-D`.

The release procedure is in the shared setup's `AGENTS.md`; it applies to
this repository only for the `dev` → `master` direction, and the `master`
line here is upstream-shaped rather than a release line.

## The agent setup is a shared package

The pi extensions and skills are **not vendored here**. They come from the
shared package declared in [`.pi/settings.json`](.pi/settings.json):

```json
{
  "packages": ["git:github.com/RRiboulet/my-agent-setup@v1.9.0"]
}
```

`pi` clones it into `.pi/git/` (gitignored, along with `.pi/npm/` and
`.pi/todos/`) and loads it for this project. **Project packages need
project trust**, so pi loads them only after the project is trusted. The pin
is a release; bump it in its own commit when a release of the shared setup
comes out, the way `RRiboulet/analytics-agent` does.

Do not copy an extension from the shared setup into this tree. The setup
repository is the single home for that code, and the plan's §2.4 says which
of those extensions the phone will eventually carry.

## Build

```bash
node scripts/package-rootfs.ts            # assets/rootfs.bin (once, or after changing the package list)
cd runtime && npm ci --omit=dev --omit=optional --ignore-scripts && cd ..
cd android
JAVA_HOME=<path-to>/tools/jdk21 ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

Four things that bite:

- **The JDK.** The app's sources are at Java 11 source level, and AGP 8.7.3
  needs JDK 17 or newer; JDK 25 is not supported by that AGP. The
  devcontainer has **17**, and the build succeeds with it — `tools/jdk21` is
  the local toolchain, and 21 works too.
- **`scripts/package-rootfs.ts` needs Linux** with `dpkg`, `dpkg-deb`, GNU
  `tar` and `gzip`, and a Node that runs `.ts` directly. It refuses to start
  without them rather than failing 200 MB in.
- **The Termux index is pinned** in `scripts/termux-index.lock`. When the
  index moves, the builder stops and says what changed; take it with
  `--update-index-lock` deliberately, after reading the diff. The lock proves
  index/deb consistency, not index authenticity.
- **The application id must be exactly ten characters**, like `com.termux`:
  the rootfs builder rewrites the prefix `/data/data/com.termux` to
  `/data/data/app.pidabl` *in place*, and a different length leaves the
  patched binaries pointing at the wrong directory. The builder refuses to
  run otherwise. `targetSdk 28` is the same constraint from the other side:
  Android 10+ blocks `exec()` of app-private files for `targetSdk >= 29`, and
  the whole runtime is execed out of the app's own prefix.

`gradlew` runs `scripts/prepare-runtime.py` before `preBuild`, so
`runtime.bin` and `payload.sha256` are rebuilt on every build. Delete
`android/app/build` before measuring or shipping an APK: an incremental build
leaves it ~25 MB larger than its contents.

## The devcontainer

`.devcontainer/` is the container this app is worked on in: JDK 17, the
Android SDK, Node, python3, tmux, gh and pi. Open the repository in it and
the build works.

Two things about it are deliberate:

- **The Android SDK is not in the image.** It is ~1.5 GB, and a rebuild must
  not cost a re-download, so `android-sdk.sh` installs it onto the
  `pi-agent-config` volume — the *same* volume the sibling setup repository's
  container uses, so the SDK is downloaded once for both. The path is fixed,
  so `android/local.properties` keeps working across rebuilds.
- **The rootfs asset is not built in the container.** It is a few minutes of
  downloads, and that does not belong in container creation, so
  `postCreate.sh` reports its absence and the command instead.

`postCreate.sh` writes the two paths Gradle needs that are gitignored, and
therefore absent from a fresh clone: `android/local.properties` and the
runtime's `node_modules`. Without the second one the build stops with a
message about a missing package rather than about a missing `npm ci`.

The extensions and skills are not in the image either: the shared setup is a
pi package declared in `.pi/settings.json`, and pi clones it into `.pi/git/`.

## Tests

```bash
npm test                          # every test/*.test.mjs
node scripts/run-tests.mjs client # only the files whose name matches
bash scripts/gate-smoke.sh        # the install gate, against a live bridge
```

They run **on the phone**, which is the point: the file the agent edits on
the phone is the file that runs, so the checks that guard it have to run
there too. `scripts/run-tests.mjs` exists because `node --test` cannot run
there — Node's own runner spawns one child per file with `process.execPath`,
and on Android that is the **dynamic linker**, not node.

## The device

The device is a **Samsung Galaxy S21 Ultra on Android 15**. What has been
run on it, and what has not, is in
[`docs/device-verification.md`](docs/device-verification.md) — read it
before claiming something works on a phone.

```bash
./scripts/device-smoke.sh        # install, bridge up, kill -9 the node, force-stop, relaunch
./install-wifi.sh                # pair and install over wireless adb
ssh -p 8022 <phone> 'pistatus'   # what the phone thinks of the bridge
```

`device-smoke.sh` needs a **debuggable** build: it reads the app's own files
with `run-as`. Wireless debugging does not always complete its handshake
(adb accepts the TCP connection and closes it); the phone's own Termux sshd
is the reliable channel.

Two phone caveats that are not bugs here: MIUI kills background processes
aggressively (the foreground service is fine), and Android 12+ may kill
node/bash subprocesses as phantom processes.

## The critical path

The plan's own §3, in [`docs/plan-revision.md`](docs/plan-revision.md),
lists six items. The first is to install the merged build and use the agent.
The second is the **install gate** — an extension the agent writes is a
proposal the user approves, not code that runs silently — which has landed
(`runtime/gate.mjs`, and `docs/install-gate.md` for what it does and what it
is not). The third is the `seq` watermark and an explicit overflow →
resnapshot in the server; the fourth is the task panel and the recovery
sheet, which need routes the server does not have; the fifth is whether the
Activity keeps its `configChanges`; the sixth is the extension ledger.

What is *not* worth doing any more is in the same document: the proot
packaging, the 16 KB alignment assertion, the `DT_NEEDED` rename, the
Android SQLite facade, a dev server on the phone, and the on-device build
toolchain. That is the whole of the plan's §1.3 and its R1/R12/R13, and it
is work for a runtime this app does not use.

## Where things live

- `android/` — the Gradle project: `PiService` (the foreground service that
  owns and supervises the runtime), `MainActivity` (a WebView that holds no
  state), `RuntimeInstaller` (extraction, versions, fingerprints).
- `runtime/` — `server.mjs` (the bridge), `common.mjs` (harness setup, the
  credential store, the session registry, the single-owner lock),
  `gate.mjs` (the install gate), `public/` (the client).
- `scripts/` — `package-rootfs.ts`, `prepare-runtime.py`, `run-tests.mjs`,
  `gate-smoke.sh`, `gh` (a small GitHub CLI for the phone), and the device
  scripts.
- `docs/` — the plan, its revision, the device verification, the reviews.
- `test/` — the host-side checks, and the ones that run on the phone too.

The layout under `filesDir` on the phone: `usr/` (the Termux prefix),
`home/` (HOME, and `~/.pi-mobile` for the bridge's state), `work/` (the
agent's working directory), `runtime/` (the bridge), `tmp/`. An app upgrade
replaces `usr/` and `runtime/` and keeps `home/` and `work/`.

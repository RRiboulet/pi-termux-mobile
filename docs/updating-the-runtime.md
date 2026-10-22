# Updating the runtime without the APK

The APK is not the only way to change what runs on the phone. Most of this
project is plain files in the app's own storage, and the bridge serves the
client with `cache-control: no-store` — so a `git pull` plus one `cp` deploys
a change, and the next page load is the change. This document says what that
covers, what it cannot cover, and what the next APK install does to it.

It exists because the shortcut is invisible until something goes wrong with it:
a hand-updated runtime looks exactly like an extracted one, and the APK that
finally arrives will delete it without asking.

## What the APK is, and what is just files

`RuntimeInstaller` extracts two payloads into `filesDir` and keeps a stamp:

| payload | lands in | contents |
|---|---|---|
| `assets/rootfs.bin` | `files/usr/` | the Termux userland: `node`, `bash`, `git`, `rg`, `fd`, `sqlite` |
| `assets/runtime.bin` | `files/runtime/` | `server.mjs`, `common.mjs`, `gate.mjs`, `models-config.mjs`, `node-bin.mjs`, `package.json`, `node_modules/`, `public/` |
| `classes.dex` | the APK | `PiService`, `MainActivity`, `RuntimeInstaller` — the Java host |

`files/home/` (HOME, credentials, `~/.pi-mobile/`) and `files/work/` (the
agent's working directory) are **not** payloads. They survive every reinstall
that does not uninstall the app.

`test/` and `docs/` are never shipped. A change to either does not exist on the
phone at all.

## Which route a change needs

| the change touches | route | why |
|---|---|---|
| `runtime/public/` (the client) | **git** | plain ES modules, no build step, served `no-store` |
| `runtime/server.mjs`, `gate.mjs`, `common.mjs`, `models-config.mjs`, `node-bin.mjs` | **git**, then restart the bridge | it is a file the bridge `import`s at start |
| `runtime/package.json`, `runtime/node_modules/` | **APK** | the dependency tree is baked into `runtime.bin` |
| `scripts/package-rootfs.ts`, the Termux package list | **APK** | the rootfs is an asset |
| `android/…/*.java`, the manifest | **APK** | that is the host, not the payload |

## What is running now

The phone's own Termux has `pistatus`, which finds the bridge on loopback and
reports what it serves:

```bash
ssh -p 8022 <phone> 'pistatus'
# bridge on 127.0.0.1:<port>, GET / -> 200, GET /api/state -> 401
```

The bridge's state is in `files/home/.pi-mobile/`: `port`, `token`,
`server.lock` (the owner lock, holding the pid).

The payload stamp is `files/.runtime-version`, and its value is
`<RUNTIME_VERSION>:<payload sha256>` — for example `46:<sha>`. Comparing it to
the installed APK's `assets/payload.sha256` is how you tell "extracted from
that APK" from "hand-edited since".

## Procedure A — a client change

This is the common case: `public/app.js`, `public/style.css`, `public/index.html`.

```bash
cd ~/work
git clone -b dev --depth 1 https://github.com/RRiboulet/pi-termux-mobile.git pi-mobile
cp pi-mobile/runtime/public/app.js ../runtime/public/app.js
```

Then **force-stop and relaunch the app**, or just reload the WebView. No bridge
restart: the client is fetched per page load, and `no-store` means a reload is
enough.

The repo is public, so no token is needed. `curl` is **not** in the app's
rootfs — that one belongs to the phone's Termux — so use `git`, or `node`:

```bash
node -e 'fetch("https://raw.githubusercontent.com/RRiboulet/pi-termux-mobile/dev/runtime/public/app.js")
  .then(r => r.text()).then(t => require("fs").writeFileSync(process.argv[1], t))' \
  ../runtime/public/app.js
```

## Procedure B — server-side code

A change to `server.mjs`, `gate.mjs`, `common.mjs`, `models-config.mjs` or
`node-bin.mjs` needs a bridge restart, because those are `import`ed at start.
The service supervises node and restarts it with backoff, so the restart is a
kill:

```bash
cp pi-mobile/runtime/server.mjs ../runtime/server.mjs
pkill -f 'files/runtime/server.mjs'      # PiService restarts it within ~1s
```

`acquireOwnerLock` (`runtime/common.mjs`) also stops a previous owner, so a
stray start cannot leave two writers: the new process SIGTERMs the old pid from
`server.lock` before it takes the store.

Restarting interrupts a running turn. Do it with nothing in flight.

## Verify

```bash
cd ~
sha256sum ../runtime/public/app.js             # what is on disk
sha256sum pi-mobile/runtime/public/app.js       # what the repo has (must match)
pistatus                                       # and it answers
```

From a container, `git show dev:runtime/public/app.js | sha256sum` is the same
comparison against the branch.

## The next APK install deletes it

`RuntimeInstaller.isInstalled` compares the stamp to the APK's own
`payloadStamp()`, so extraction happens **only** when the APK's payload changed
or `RUNTIME_VERSION` moved. Two consequences:

- Reinstalling the **same** APK re-extracts nothing, and hand-copied files stay.
- Installing a **different** APK calls `install()`, which deletes `files/usr`
  and `files/runtime` before extracting. Every hand-copied change in the runtime
  is wiped — correctly, because the payload is now the source of truth. `home/`
  and `work/` are kept.

So: git is for changes that have not reached an APK yet, and installing an APK
is the way to make them permanent — after which the git copy is irrelevant.

## The signature trap

The debug keystore lives in the **container**, at `~/.android/debug.keystore`,
and it is not on the `pi-agent-config` volume. A rebuilt devcontainer therefore
has a new key, and an APK built in it **cannot update** an app installed from an
APK built in an earlier container — the installer refuses, and the only way
forward is uninstall-then-install.

Uninstalling deletes `files/`, including `home/` (sessions and credentials) and
`work/`. There is no in-app export yet.

Check before you tap:

```bash
<build-tools>/apksigner verify --print-certs android/app/build/outputs/apk/debug/app-debug.apk
```

and compare the `SHA-256 digest` to the installed app's. If they differ, the
git route above is not a convenience — it is the only route that does not cost
you the app's data.

## Rollback

Keep the old file before overwriting it, since nothing else will:

```bash
cp ../runtime/public/app.js ../runtime/public/app.js.bak
```

`git clone` of any commit gives the old version back:
`git -C pi-mobile show <sha>:runtime/public/app.js > ../runtime/public/app.js`.

## Why this works at all

Two properties, both deliberate and both easy to break:

1. **There is no build step.** `runtime/public/` is plain ES modules; the file
   the agent edits is the file that runs. A bundler would turn this page into
   "run the build on a phone", which is the thing this project exists to avoid.
2. **The bridge serves the client with `cache-control: no-store`**
   (`runtime/server.mjs`, `serveStatic`). Without it, a WebView would happily
   keep serving the old client and the update would look like it did nothing.

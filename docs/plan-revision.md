# What changed in the plan, and why

The plan (`docs/pi-durable-android-plan.md`, 2,456 lines) was written for a
**proot + glibc** Android app: a Kotlin host, a rootfs unpacked from
`nativeLibraryDir`, and Pi Durable at the unreleased `main@fdce48e`.

We are instead building on **a fork of jeamy's `pi-termux-mobile`**: a Java
host, a **Termux bionic prefix unpacked into `filesDir`** at **targetSdk 28**,
and Pi Durable at **1.0.3**.

That is not a small change of plan; it changes the answer to the plan's one
load-bearing question, and it moves work from the riskiest end of the plan to
the least risky. This is what changes, section by section.

---

## 0. The short version

| | the plan | where we are |
|---|---|---|
| Runtime | proot, glibc rootfs, `nativeLibraryDir`, targetSdk 35 | **Termux bionic prefix, `filesDir`, targetSdk 28** |
| Host | Kotlin | **Java** (the fork's) |
| Pi Durable | `main@fdce48e` (unreleased) | **1.0.3** |
| R1 — "can a Node runtime run on a phone at all?" | the load-bearing unknown | **answered: yes, on a Galaxy S21 Ultra, Android 15** |
| A dev server on the phone | Vite, with a spike | **moot: no build step, so the agent edits the file that runs** |
| The IPC contract | `WS /v1/events`, a `seq` watermark, a scoped snapshot vocabulary | **pi-pocket's contract** (SSE), partly superseded |

**What we give up:** the wake/sleep API, `restartLimit` and the parked-task
recovery (all `main`-only), the plan's own event contract, and the Kotlin host.
**What we get:** a runtime that is already proven on the phone, a third of the
build-system work, and the single most valuable property the plan was reaching
for — *the file the agent edits is the file that runs*.

---

## 1. What changes, section by section

### §0 Sources checked, §1.1 "Four premises to correct first"

The plan's §0 and §1.1 tables dismiss "pi-phone" as *not* a runtime you can
bundle — they mean **`MaliNamNam/pi-phone`**, a different project with the
same name. **`picassio/pi-phone` and its fork `jeamy/pi-termux-mobile` are
exactly that**: a Termux userland in an APK, with Pi Durable as the kernel and
a WebView client. The plan's premise was right about one project and wrong
about the other. The landscape survey that established this is no longer kept
in the tree; the decision it supports is Appendix B.

### §1.3 The runtime — **inverted, and now measured instead of argued**

The plan spends its longest section on "the mechanism, because it is what S0.1
has to prove": proot as `libproot.so` in `jniLibs`, a glibc rootfs, the
`DT_NEEDED` rename, the `RUNPATH → $ORIGIN` rewrite, and a 16 KB alignment
assertion because `patchelf` breaks it silently.

**None of that is needed.** The fork runs the **Termux prefix** in `filesDir`
and execs it directly, which targetSdk 28 permits (the API-29+ app-home exec
ban is keyed on targetSdk). The cost is a different set of constraints:

- **The applicationId must be exactly ten characters.** The prefix is rewritten
  **in place** — `/data/data/com.termux` → `/data/data/app.pidabl`, 21 bytes
  each — so the two must be the same length or the patched binaries point at
  the wrong directory. This replaces the plan's packaging constraints with one
  rule, and it is a *build-time* error, not a device failure.
- **The escape hatch is `linker64`, not proot.** `PiService` falls back to
  `/system/bin/linker64 <binary>`, so the targetSdk can be raised later
  without re-architecting.
- **R1 is closed.** It is not "the runtime might work" — it works, on a real
  phone, with a real glibc-free userland. The numbers the plan asked for are
  measured: a 70 MB rootfs, a 95 MB APK, a first-launch extraction of ~170 MB.
- **The plan's cost list is now irrelevant**: no proot syscall overhead, no
  16 KB alignment, no `libtalloc` rename, no `nativeLibraryDir` SELinux
  gamble.

### §1.5 Option C1 (remote execution) — **was built, and has now been pruned**

The plan treats C1 as something to build if Option A fails. The fork *had* it:
`RemoteExecutionEnv`, a `remote:<name>:/path` cwd convention, SSH tunnelling,
and an `env-server` that runs commands on another host. The plan's C1 was a
finished feature here, and the plan's §1.6 `envFor` seam existed in the fork's
shape (`places.env(cwd)` picked the local or the remote env from the cwd).

**That is no longer true of the tree.** PR #2 (`chore: prune to a phone-only
app`) removed the whole remote plane — `remote-env.mjs`, `env-server.mjs`,
`remote-client.mjs`, `remote-provision.mjs`, `remote-state.mjs`,
`pi-serverd.mjs` and the SSH host registry — along with the pages that were
its only entry points. The code is in `feature/remote-subsystem` and in the
`pre-prune-2026-10-21` tag, so it was *parked*, not lost.

The decision it rests on: a phone cannot arm a remote plane. `PI_REMOTES` was
never set by the Android host, and `remotes.json` lives in app-private
storage, so the capability had no reachable entry point in this app. The cost
of the bet is 322 lines of code that will have to be re-merged if the app ever
grows a second host — against 16,598 lines of desktop-shaped machinery
removed. The `envFor` seam survives in `runtime/server.mjs` with nothing to
swap in, which is the shape to restore from if that day comes.

### §1.7 Storage — **unchanged, and confirmed on the device**

The plan chose `openNodeSqliteStorage` over an Android SQLite facade. The fork
does exactly that, and `node:sqlite` **works on the phone** — the report in
`docs/device-verification.md` is the evidence. The facade (Option B) is moot,
so the plan's S0.2 spike disappears.

### §1.8 Process model — **matches the plan's diagram; one invariant is not exercised**

The fork's shape is the plan's diagram: one Node process owns the SQLite file,
the WebView is a passive client over loopback, and the Activity holds no
durable state. The single-writer invariant is enforced — `acquireOwnerLock` on
`server.lock` (the plan's "child-owned FileLock fallback", in the shape of a
pid lockfile).

**But the fork's Activity declares `android:configChanges`
(`orientation|screenSize|keyboardHidden`)**, so it survives rotation instead of
being destroyed and recreated. The plan's invariant — *"the Activity is
disposable; it is destroyed and recreated without touching the kernel"* — is
therefore **not exercised**, and the Activity is a long-lived holder of the
WebView. This is the one place where the fork is *less* faithful to the plan
than the plan asks, and it is worth deciding deliberately: drop
`configChanges` so rotation really does rebuild the Activity from a fresh
snapshot (the plan's §3.8), or keep it and accept a WebView that outlives
rotation.

### §1.9 The IPC contract — **superseded, with two things worth porting**

The plan specifies a `WS /v1/events` with a `snapshot`/`batch`/`entry`/`doc`/
`taskgraph`/`submission` vocabulary, a `seq` watermark, a scoped snapshot with
a child index, and a bounded per-connection queue that overflows into a
resnapshot.

The fork speaks **pi-pocket's contract**: `GET /api/events` (SSE), whose first
frame is `{type:'bridge_snapshot', snapshot, sessionName}` and whose later
frames are raw pi-durable events. The client is now written against that, and
the review's worst finding was a client that guessed the contract instead of
reading it.

**What the fork already has:** per-conversation scoping (the server attaches
`watchEvents` per conversation), a snapshot on attach, and committed-state-only
rendering. **What the plan's contract adds and the fork lacks:** the `seq`
watermark (so a reconnect can resume rather than re-snapshot), an explicit
"the snapshot fully reconstructs the view" contract, and a bounded queue that
says so.

**Recommendation:** keep pi-pocket's contract — it is proven and the client
exists — and port **the `seq` watermark** and **an explicit overflow →
resnapshot** into the server. The plan's §1.9 becomes a description of the
fork's contract rather than a new one.

### §2 Extension porting — **unchanged in substance; the ledger is still right**

The plan's §2.4 ledger (which of the thirteen extensions survive) is unaffected.
The fork's server already has the extension model the plan assumes: a
registry, `defineTool`, `reload.ts` with a load deadline and a generation
counter, and hot `registry.install()`.

**One gap the plan's §2.8 requires and the fork does not have:** the
**user-confirmed install**. The fork installs a drop-in the moment the file
changes. That is the single most important thing to build in §2/§4, because
the fork's self-building loop is *easier* to reach and therefore *more* likely
to be used.

### §3 UI/UX — **the plan's screen set, against a client that now exists**

The new client implements **S1** (the
transcript, with thinking blocks), **S2** (the composer, with Steer / Stop),
**S3** (the status line) and **S7** (usage). **S4** (the task panel),
**S5** (the subagent view), **S6** (the recovery sheet) and **S8** (the git
viewer) are **not** in it.

S4 and S6 are not client work: the fork's server exposes **no task-graph and
no `inspect` route** (the route list has no `/api/tasks` and no `/api/graph`).
Those are server work, and they are the plan's §3.6/§3.7 requirements.

### §4 The self-building loop — **mostly already there, and stronger**

The plan's R1 (hot install) is the fork's `reload.ts`. The plan's R2 (the
agent edits the UI) is now **better than the plan imagined**: there is no build
step, so `runtime/public/app.js` is plain ES modules and the file the agent
edits on the phone *is* the file that runs. The plan's R3 (kernel restart) is
the fork's service supervision.

**What is missing is the plan's §4.4 gate**: the diff, the hash, the user's
tap, and only then `registry.install()`. And the plan's §4.3 invariant — a
restart is an ordinary event — is already satisfied: `harness.resume()` runs on
every start.

### §5 Risks — what closes, what stays

| risk | status |
|---|---|
| **R1** Node runtime on Android | **closed** — it runs |
| **R3** OEM killers | the *parking* feature is `main`-only and we are on 1.0.3, so there is nothing to configure; the fork resumes pending work on every start, which covers the behaviour. Samsung's battery settings remain the real mitigation |
| **R5** single writer | enforced by an owner lock |
| **R6** foreground-service policy | moot at targetSdk 28. If the targetSdk ever rises, the fork's `dataSync` type carries the 6 h/24 h cap and `specialUse` is the answer |
| **R8** credentials | the fork's `secrets.ts` keeps them out of `process.env` and injects them per command |
| **R11** loopback and the token | `network_security_config.xml` scopes cleartext to loopback; the token is the boundary. The plan's "one-time ticket instead of a token in the query string" is still worth doing |
| **R12** a dev server on the phone | **moot** — no build step, so there is no bundler on the phone at all |
| **R13** on-device build, no-USB install | sidestepped — there is nothing to build on the device |

### §6 Phased plan — **Phase 0 is over**

Phase 0 existed to answer one question with a measurement. It is answered, and
not by a spike: by the fork, running, on the phone. The plan's S0.1 (proot),
S0.2 (the Android SQLite facade), S0.6 (a dev server on the phone) and
S0.7 (on-device build) are **answered or moot**. What remains is the plan's
Phase 1 onward, re-expressed against the fork.

### Appendix A (the verified API surface) — **re-verify against 1.0.3**

It was verified against `main@fdce48e`. The fork runs 1.0.3, which has
`subscribeCommits` and the `replay` field, but **not** `onWake`, `wake()`,
`settings.restartLimit`, `harness.retryTask()`, `TaskGraphState.sleeping` or
`TaskGraphNode.blocked`, and it does **not** require `checkpointWhen`.

### Appendix B (the decisions taken) — **three of them change**

1. *The runtime* — Termux bionic prefix at targetSdk 28, not proot at 35.
2. *The version* — 1.0.3, not `main@fdce48e`, and the wake/sleep and
   restart-parking design is dropped rather than deferred.
3. *The host* — Java, inherited, not Kotlin.

---

## 2. The decision that is actually open: 1.0.3 or `main@fdce48e`?

Staying on 1.0.3 is the cheaper path and it is viable:

- the fork resumes pending work on every start, so an OEM kill costs a
  restart, not a task;
- the replay policy, the `replay` field, `subscribeCommits` and the storage
  facade are all present in 1.0.3;
- the wake/sleep API is what the plan's §1.10 design was *for*, and at
  targetSdk 28 the kernel can be suspended by the OS — which is exactly the
  case the wake lock and the alarm exist to handle. The fork holds a partial
  wake lock for the life of the service, which is blunter but works.

Moving to `main@fdce48e` buys the wake/sleep API, `restartLimit` and
`retryTask`, and costs a version of Pi Durable that is unreleased, whose
database schema is already at version 2 and one-way, and whose API changes
without notice.

**Recommendation: stay on 1.0.3 until something needs the main-only APIs.**
The first thing that would need them is S4 (the task panel), because the
parked-task state and `retryTask` are what that screen shows. That is a
reason to upgrade *when S4 is built*, not before.

## 3. The new critical path

> **Status 2026-10-27:** items 1–3 are done — the agent is installed and current,
> the install gate landed, and the watermark plus overflow→resnapshot are in
> `runtime/watermark.mjs`. Items 4–6 remain; `next-steps.md` has the live queue.

1. **Install the merged build** and use the agent. The client is now contract-
   correct: the transcript loads, the composer keeps your draft, "New session"
   creates a session, and the thinking blocks show.
2. **The install gate** (§2.8 / §4.4): diff, hash, tap, install. This is the
   highest-value thing to build next, because it is what makes the loop safe,
   and the fork's loop is otherwise wide open.
3. **The `seq` watermark** and an explicit overflow → resnapshot in the
   server (§1.9), so a reconnect resumes instead of re-snapshotting.
4. **S4 and S6**: the task panel and the recovery sheet, which need
   `/api/tasks` and an `inspect` route the server does not have.
5. **Decide the Activity's `configChanges`** (§1.8): keep it, or make the
   Activity disposable as the plan insists.
6. **The extension ledger** (§2.4): which of the thirteen extensions port, and
   their `replay` policy.

## 4. What is not worth doing any more

- The proot packaging work, the 16 KB alignment assertion, the `DT_NEEDED`
  rename, `nativeLibraryDir`, the `nativeLibraryDir` SELinux gamble, the
  Android SQLite facade, the Vite dev server on the phone, and the on-device
  build toolchain. That is the whole of the plan's §1.3 and §5 R1/R12/R13, and
  it is now work for a runtime we are not using.

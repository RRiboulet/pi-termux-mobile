# The install gate

The agent can write code. Code it writes **for the kernel** is not sandboxed
code: an extension runs inside the bridge process, with the bridge's uid and
its secrets. The plan says so in §2.8, and repeats it in §4.4:

> **Agent-written extensions are user-confirmed installs.** The agent writes
> `workspace/extensions/foo.ts`; the kernel shows the file, hash and diff; the
> user taps **Install**; then `registry.install()`. This is the v1 default.
>
> An agent-written extension is kernel code, not sandboxed code.

This document is what that looks like in this repository — and what it does
**not** do.

## What it does

```
 the agent                        the bridge                        the user
 ────────                        ────────                        ───────
 writes   work/extensions/demo.mjs
                                  hashes what it finds
 propose via extension_propose    ───────────────────────────▶   the Extensions
                                  shows the whole file,             sheet: the file,
                                  the sha256 and the diff           the hash, the diff
                                                                       │
                                  imports the approved bytes,  ◀─── taps Install
                                  and the tool is in the
                                  next turn's tool list
```

The install is a **hot install**: pi-durable reads the registry when it
resolves an agent, not when the harness opens, so the new tool is in the next
turn's tool list. No restart, and the session is untouched.

`scripts/gate-smoke.sh` checks all of it against a live bridge: it boots the
server the way the phone does, has the agent propose an extension, approves
the hash it was shown, and asks the (test) model to call the new tool — then
restarts the bridge and checks the tool is still there. It has a **negative
control**: before the install, the same call has to fail with "the tool is not
available", which says both that the message was well formed and that the
tool was genuinely not there. A check that cannot fail is not a check.

## What it is not

**The gate is an accident guardrail, not a boundary**, and the plan says so
in §2.8. Three things it does not do:

1. **It does not stop the agent from running code.** The agent has `bash`, in
   the bridge's own uid. It could call the install route itself. It could
   write the ledger — the ledger is a file in the agent's own `HOME` — and
   have its extension installed at the next restart. And it could edit the
   bridge's own source: `files/runtime/server.mjs` is in the same app-private
   storage, the service restarts node, and the modified bridge comes back up.
   The gate does not close that, and cannot: the plan puts a real boundary in
   a separate spike (a second app package with its own uid), and this is not
   it.
2. **It does not meet the plan's R10 sentence.** The plan's §5 says a
   user-confirmed install means "the agent cannot silently become kernel
   code". Here the agent *can*, by the routes above. What the gate does is
   narrower and worth saying out loud: **the ordinary path — write an
   extension, propose it — needs a tap.** The plan's own §2.8 threat model
   says the guardrail is an accident guardrail and the recovery path is a
   scheduled export; this is the guardrail half.
3. **It does not make the ledger authoritative.** The ledger is the bridge's
   record of what the user approved, and it lives in a directory the agent
   can write. What the gate does about that is to make the ledger *self
   consistent*: a restore installs a file only when the file's bytes and the
   ledger's recorded bytes agree, so a hand-edited or forged ledger cannot
   quietly authorize different code.

What the gate does buy, concretely:

- the user sees the **whole file**, its hash and its diff before it runs in
  the kernel;
- the hash is what is approved, and **the bytes that are imported are the
  bytes that were hashed** — the approved text is written to a shadow file
  and that is what is loaded, so a file that changes in the meantime cannot
  slip in under the approval;
- a proposal **cannot take over** the app's own extensions or tools: the
  registry replaces by name, and the last extension wins a tool-name
  collision, so `coding-tools`, `subagent` and `install-gate` are reserved
  and a tool the kernel already has cannot be shadowed;
- a proposal the user refused stays refused, so the agent cannot propose the
  same file in a loop;
- the kernel's extensions survive a bridge restart, and a file that changed
  while the bridge was down is *not* silently reinstalled.

## The rules

A proposal is an ES module in the workspace's `extensions/` directory. It is
refused unless it has:

- a `name`: lowercase letters, then letters, digits, `-` or `_`, and not one
  of the app's own;
- `tools`: each with a `name`, a `description`, `parameters` (a JSON schema)
  and an `execute` function, and a name the kernel is not already using;
- optionally `sections`: each with a `key` and a `render` function.

**Anything else is refused, by name.** `tasks`, `wraps` and `hooks` are not
accepted in v1 — a task is scheduled by the kernel, a wrap intercepts other
tools and a hook runs around every tool call, and all three are a much larger
surface than a tool. So is any key the gate does not know: a file the user
approved and the kernel did not install is worse than a refusal, because the
user thinks they approved something that is running.

**Every tool is installed with `replay: 'unsafe'`.** That is pi-durable's own
default, and it is the right one here: 'safe' means the tool may run *again*
after a crash, and nobody can show that agent-written code is safe to run
twice.

**An extension needs nothing from the runtime.** `defineTool` is an identity
function, and a tool's parameters are a plain JSON schema, so a proposal can
be a standalone module. That is deliberate: a link to the kernel's own
`node_modules` inside a directory the agent can write to would be a way into
the kernel's packages, and the plan's boundary is a separate package with its
own uid, not a symlink.

**The file is evaluated when it is installed.** The shape of an extension is
the result of running it, so the rules cannot all be checked before it runs.
What the gate refuses *before* the import is everything it can know: the
path, the hash, the file's size, and the fact that it is a `.mjs` or `.js`
file. Everything else is checked on the module it produced, and the file is
refused — with the reason on the card — if it does not fit.

## Where things live

| what | where on the phone |
|---|---|
| the proposals | `files/work/extensions/` — the agent's working directory |
| the state | `files/home/.pi-mobile/extensions.json` — what is installed, what was refused, what failed, what was proposed |
| the code | `runtime/gate.mjs` — the gate itself |

Both directories survive an app upgrade (`RuntimeInstaller` replaces `usr/`
and `runtime/` and keeps `home/` and `work/`), so the user's decisions
outlive the APK.

The sheet lists the files the agent **proposed**, not every file in the
directory: a helper module next to an extension is not something to install.

The state file keeps the content of what was installed, so the diff the user
sees for an update is against the version that was approved, not against
whatever the file happens to hold now. A restore checks the two against each
other: a ledger that says one thing and a file that says another is not an
approval of either.

## The API

| route | what it does |
|---|---|
| `GET /api/extensions` | the installed extensions, the pending proposals (with hashes, diffs and the whole file), and the problems |
| `POST /api/extensions/install` | `{ key, hash }` — installs the file, if it still hashes to `hash` |
| `POST /api/extensions/reject` | `{ key, hash }` — refuses this version of the file |
| `POST /api/extensions/uninstall` | `{ key }` — takes an extension back out of the registry |

The bridge pushes a `bridge_extensions` event over the SSE stream whenever the
proposals change, so the sheet is never stale — including the ordinary case
of a file that changed after it was installed, which is the step the
self-building loop takes most often.

## The agent's tool

`extension_propose` is the only way in. The agent writes the file and calls
the tool; the tool records the proposal — that is what puts it in front of
the user — and says where it stands:

> `demo.mjs is proposed (sha256 4c3a14602a0c). The user has to approve it in
> the Extensions sheet before it runs.`

The tool cannot install anything.

## What is not here yet

- **The trusted-session path.** The plan's §2.8 has a second mode: the user
  pre-authorizes a pinned key or hash, so a long self-building session does
  not ask on every iteration. Default off, and not built. It is the natural
  next thing: the hash is already the unit of approval.
- **The recovery export.** The plan's §2.8 puts a scheduled, redacted export
  on the storage side, so a corrupted store can be restored. That is a
  separate piece of work, and the store is the thing the gate does not touch.
- **A boundary.** A second app package with its own uid is the only real one,
  and it is a spike, not a v1 feature. Until it exists, the gap between
  "the ordinary path needs a tap" and "the agent cannot silently become
  kernel code" is real, and this document says so rather than pretending
  otherwise.
- **A ledger the agent cannot write.** See "What it is not". Closing that
  means the same thing as the boundary: a place the agent cannot reach.

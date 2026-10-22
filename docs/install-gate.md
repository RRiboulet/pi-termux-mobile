# The install gate

The agent can write code. Code it writes **for the kernel** is not sandboxed
code: an extension runs inside the bridge process, with the bridge's uid and
its secrets. The plan says so in §2.8, and repeats it in §4.4:

> **Agent-written extensions are user-confirmed installs.** The agent writes
> `workspace/extensions/foo.ts`; the kernel shows the file, hash and diff; the
> user taps **Install**; then `registry.install()`. This is the v1 default.
>
> An agent-written extension is kernel code, not sandboxed code.

This document is what that looks like in this repository.

## What it does

```
 the agent                        the bridge                        the user
 ────────                        ────────                        ───────
 writes   work/extensions/demo.mjs
                                  scans the directory,
                                  hashes what it finds
                                  ───────────────────────────▶   the Extensions
 propose via extension_propose    shows the file, the sha256       sheet: the file,
                                  and the diff                        the hash, the diff
                                                                       │
                                  installs it, and the tool      ◀─── taps Install
                                  is in the next turn's
                                  tool list
```

The install is a **hot install**: pi-durable reads the registry when it
resolves an agent, not when the harness opens, so the new tool is in the next
turn's tool list. No restart, and the session is untouched.

`scripts/gate-smoke.sh` checks all of it against a live bridge: it boots the
server the way the phone does, proposes an extension, approves the hash it was
shown, and asks the (test) model to call the new tool — then restarts the
bridge and checks the tool is still there.

## What it is not

**The gate is an accident guardrail, not a boundary.** The agent runs in the
same process as the bridge, with the same uid, and can read the bridge's
token. It could call the install route itself. The gate makes the *user* look
at the code before it runs, and it makes the kernel changing its own behaviour
an explicit, recorded act — it does not contain a malicious agent, and the
plan's §2.8 is explicit that a real boundary is a separate spike (a second app
package with its own uid).

What the gate does buy, concretely:

- the user sees the code, its hash and its diff before it runs in the kernel;
- the hash is what is approved, so a file that changed in the meantime is
  refused rather than installed;
- a proposal the user refused stays refused, so the agent cannot propose the
  same file in a loop;
- the kernel's extensions survive a bridge restart, and a file that changed
  while the bridge was down is *not* silently reinstalled.

## The rules

A proposal is an ES module in the workspace's `extensions/` directory. It is
refused unless it has:

- a `name`: lowercase letters, then letters, digits, `-` or `_`;
- `tools`: each with a `name`, a `description`, `parameters` (a JSON schema)
  and an `execute` function;
- optionally `sections`: each with a `key` and a `render` function.

`tasks` and `wraps` are **refused in v1**. A task is scheduled by the kernel
and a wrap intercepts other tools: both are a much larger surface than a tool,
and nothing here needs them yet.

**Every tool is installed with `replay: 'unsafe'`.** That is pi-durable's own
default, and it is the right one here: a replayed tool runs *again* after a
crash, and nobody can show that agent-written code is safe to run twice.

An extension does not have to import anything. If it wants `defineTool` or a
TypeBox schema, the gate puts a `node_modules` symlink next to the proposals,
pointing at the runtime's own.

## Where things live

| what | where on the phone |
|---|---|
| the proposals | `files/work/extensions/` — the agent's working directory |
| the state | `files/home/.pi-mobile/extensions.json` — what is installed, what was refused |
| the code | `runtime/gate.mjs` — the gate itself |

The state file keeps the content of what was installed, so the diff the user
sees for an update is against the version that was approved, not against
whatever the file happens to hold now.

## The API

| route | what it does |
|---|---|
| `GET /api/extensions` | the installed extensions and the pending proposals, with hashes and diffs |
| `POST /api/extensions/install` | `{ key, hash }` — installs the file, if it still hashes to `hash` |
| `POST /api/extensions/reject` | `{ key, hash }` — refuses this version of the file |
| `POST /api/extensions/uninstall` | `{ key }` — takes an extension back out of the registry |

The bridge pushes a `bridge_extensions` event over the SSE stream whenever the
proposals change, so the sheet is never stale.

## The agent's tool

`extension_propose` is the only way in. The agent writes the file and calls
the tool; the tool records the proposal and tells the agent where it stands:

> `demo.mjs is proposed (sha256 4c3a14602a0c). The user has to approve it in
> the Extensions sheet before it runs.`

The tool cannot install anything.

## What is not here yet

- **The trusted-session path.** The plan's §2.8 has a second mode: the user
  pre-authorizes a pinned key or hash, so a long self-building session does
  not ask on every iteration. Default off, and not built.
- **The recovery export.** The plan's §2.8 puts a scheduled, redacted export
  on the storage side, so a corrupted store can be restored. That is a
  separate piece of work, and the store is the thing the gate does not touch.
- **A boundary.** A second app package with its own uid is the only real one,
  and it is a spike, not a v1 feature.

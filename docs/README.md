# Documentation

This directory holds the record of **pidabl**: the phone-native Pi Durable
agent, built on the Termux-prefix lineage in this repository.

The documents are in two groups. The first is *the app*: what it is, what was
found wrong with it, and what was measured on a real device. The second is
*the plan it came out of*: a longer piece of work, kept because it explains
why the app looks the way it does.

## The app

| document | what it is |
|---|---|
| [plan-revision.md](plan-revision.md) | **Start here.** What changed in the plan when the app moved to this lineage, section by section, and the new critical path. |
| [device-verification.md](device-verification.md) | What was actually run on a Galaxy S21 Ultra (Android 15): the runtime, the SQLite file, the loopback bridge, the service. |
| [gh-tool.md](gh-tool.md) | `scripts/gh`, the small GitHub CLI the agents use: a pull request, a review, a comment, a diff — over the REST API, with a token that goes to one origin and nowhere else. |
| [install-gate.md](install-gate.md) | The install gate: the agent proposes an extension, the user is shown the file, its hash and its diff, and taps Install. What it does, and what it is not. |
| [reviews/ui-review.md](reviews/ui-review.md) | The client review, in three passes, and the defects it found. |
| [reviews/S0.1-review.md](reviews/S0.1-review.md) | The review of the *spike* — the proot route that was measured and then not taken. Kept as the audit trail for the decision. |

## The plan

| document | what it is |
|---|---|
| [pi-durable-android-plan.md](pi-durable-android-plan.md) | The original plan: kernel architecture, extension porting, the UI, the self-building loop, the risks. Written for a proot + glibc app; **superseded in part** — read `plan-revision.md` first. |
| [pi-durable-android-oss-review.md](pi-durable-android-oss-review.md) | The survey of the existing landscape: what runs Pi Durable on a phone today, and what each project actually does. The corrected answer to §1.1's "four premises". |
| [S0.1-RUNBOOK.md](S0.1-RUNBOOK.md) | How the spike was to be measured, on the device, and what each cell meant. |
| [S0.8-DECISION-RECORD.md](S0.8-DECISION-RECORD.md) | The blank decision record the spike was to fill in. |
| [spikes/BASELINE-x86.md](spikes/BASELINE-x86.md) | The host-side baseline the device numbers are compared against. |
| [spikes/S0.1-2026-10-21a-launch-failed.json](spikes/S0.1-2026-10-21a-launch-failed.json) | The device's own report from the first (and only) spike run. |

## Two architectures, one decision

This repository's lineage and the deleted `pi-android` repository were two
routes to the same goal: Pi Durable running on an Android phone.

- **The one that is here** — the **Termux bionic prefix**, unpacked into
  `filesDir`, execed directly, at `targetSdk 28`. It runs. It is what the
  phone is running now.
- **The one that was not** — **proot** with a glibc rootfs, unpacked from
  `nativeLibraryDir`, at `targetSdk 35`. It was a real spike, on a real
  device, and it failed at the first launch: `proot error: unknown option
  '-e'`.

The spike's report is in `spikes/`, and `reviews/S0.1-review.md` has the
review. What the failure proved is worth keeping: the **API-29+ app-home exec
ban is active** on the device, which is the constraint the Termux route also
respects — by staying at `targetSdk 28`, where the ban does not apply.

The proot route is not refuted by that failure. It was never finished. It was
dropped because the other route was already running.

## The shape of the thing

```
Android app  (app.pidabl, targetSdk 28)
├── PiService            a foreground service: owns the runtime, supervises it
├── MainActivity         a WebView; loads the loopback bridge; holds no state
└── filesDir/
    ├── prefix/          the Termux userland, applicationId-rewritten
    │   └── node → ...   Node 24, with node:sqlite
    └── state/
        ├── server.lock  the owner lock: one writer, ever
        └── pi-durable.sqlite
             ▲
             │ one process owns the file
             │
        runtime/server.mjs   the bridge: SSE, the API, the harness
             ▲
             │ loopback HTTP
             │
        runtime/public/       the client: no build step, plain ES modules
```

The line that matters: **the client is a passive view**. It holds no
durable state, and the file the agent edits on the phone is the file that
runs.

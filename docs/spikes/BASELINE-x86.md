# Baseline measurements — x86_64 host, no proot

Collected on the devcontainer (Linux 6.18, x86_64, 4 cores) with the **same Node
build** that goes into the phone's rootfs (v24.22.0, official arm64 tarball — the
version string is identical, only the architecture differs).

These are **not** a pass/fail threshold. proot's overhead is architecture- and
kernel-dependent, and the phone's CPU is a different machine. They exist so the
S21 Ultra numbers have a scale to be read against, so "the stat loop took 4 seconds"
can be recognised as "proot made syscalls 20× more expensive" rather than "the phone
is slow".

## Raw output

```json
{"ok":true,"cpuMs":65,"stat200kMs":192,"usPerStat":0.96,
 "write500x1kMs":8,"read500x1kMs":3,
 "big16mbWriteMs":5,"big16mbReadMs":8,
 "acc":5490,"nodeVersion":"v24.22.0"}
```

## What each number means

| Metric | What it is | Native value |
|---|---|---|
| `cpuMs` | 20M iterations of pure arithmetic — **no syscalls at all** | 65 ms |
| `stat200kMs` | 200,000 `stat()` calls — **entirely syscall-bound** | 192 ms |
| `usPerStat` | 192 ms / 200k = cost of one syscall | 0.96 µs |
| `write500x1kMs` | 500 × 1 KB file writes | 8 ms |
| `read500x1kMs` | 500 × 1 KB file reads | 3 ms |
| `big16mbWriteMs` | one 16 MB file write | 5 ms |
| `big16mbReadMs` | one 16 MB file read | 8 ms |

## How to read the phone's numbers

The interesting quantity on the phone is **not** the absolute speed - it is the ratio
between the syscall-bound work and the pure-compute work *inside the same proot run*:

```
syscallToComputeRatio  =  (stat200kMs / 200000)  /  (cpuMs / 20_000_000)
```

> **Correction (2026-10-21).** This ratio was previously read as "proot's overhead
> factor", with thresholds of 1-5x / 5-20x / > 50x. **Those thresholds cannot be
> right, and the numbers in this file disprove them:** the ratio on this *native* x86
> host is ~263 - with no proot in the picture at all. One syscall is simply orders of
> magnitude dearer than one arithmetic iteration on any machine.
>
> So the ratio measures **the device and the runtime together**. It becomes a measure
> of proot's overhead only when it is compared with the same ratio measured
> **natively on the same device**. The spike cannot do that: its Node exists only
> inside the rootfs. What the spike *can* say is the absolute cost of a syscall under
> proot (`usPerStat`); how much of that is proot's translation needs a same-device
> native control, which is a follow-up.
>
> The `cpuMs` number is still the control for the CPU: it involves no syscalls, so
> it should be close to the phone's native speed. If `cpuMs` on the phone is *also*
> far worse than this x86 baseline, that is the CPU, not proot.

## The SQLite check (also native, x86)

```json
{"ok":true,"rows":1000,"firstRow":"row-0","integrity":"ok",
 "journalMode":"wal","pageSize":4096,
 "insertMs":2,"readMs":0,"totalMs":17,"nodeVersion":"v24.22.0"}
```

This is the check that validates the plan's central assumption on the *host* side:
**Node 24's `node:sqlite` exists, opens a WAL database, and survives a transaction.**
The phone's number should be in the same order of magnitude. It says nothing about
whether the same is true on the phone - that is what `node-sqlite-1000-rows` in the
S0.1 report is for.

All four spike scripts now honour `SPIKE_DIR` (default `/pi`, the guest's
directory), so they can be run on a host exactly as `AGENTS.md` asks:

```bash
cd app/src/main/assets/spike && SPIKE_DIR=/tmp/spike-check node sqlite.js
```

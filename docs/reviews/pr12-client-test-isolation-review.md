# Review — PR #12 `fix(ui): a client paints into the document it booted into`

**Scope:** `fix/client-test-isolation` @ `6b3ce57`, against `dev` @ `6842002`.
**Merged:** squash-merged as `167a4a1`; the reviewed head `6b3ce57` is in the
remote branch's reflog only, so this document is what the review was of.

Two independent passes, run before the merge: an **adversarial** pass (`glm-5.3-flash`,
high) whose job was to falsify the change, and a **design-complexity** pass
(`deepseek-v4.1-flash`, high). Both worked read-only, on copies in `/tmp`, and
were asked for discrete findings with evidence.

**The headline: the two passes reached the same verdict from opposite
directions — the fix was right, and the second half of it had to go.**

---

## What the change was

The client resolved the global `document` at **paint** time rather than at
boot, so a client instance that outlived its test painted into whatever
document was global by then. The OAuth poll is what made an instance outlive
its test: it re-asks the bridge 1200 ms after a login starts, the test that
starts one finishes first, and the timer then fired inside a *later* test —
calling that test's `fetch` mock and painting the old module's OAuth sheet over
the new test's DOM. The Extensions sheet the test had just opened, Install
button and all, was replaced from under it, several tests away from the test
that caused it.

The reviewed head bound `const doc = document` once at module scope, and also
carried a test-harness change: ~20 lines patching `globalThis.setTimeout` to
track timers and clear leaked ones at each `mount()`.

## What the reviews found

| # | finding | lens | disposition |
|---|---|---|---|
| 1 | The timer harness is not load-bearing and is a net negative. Remove it. | complexity, measured | **removed** |
| 2 | The harness guaranteed `pollOauth`'s callback body never executes: the guard, the event accumulation and the error path lost their only execution. | adversarial | **accepted as a gap**; recorded below |
| 3 | `app.js`'s comment justified the fix with a production scenario that cannot occur — an ES module gets one `document` for its life, and navigating unloads the module and its timers with the page. | adversarial, complexity | **comment cut to the real invariant** |
| 4 | The harness cleanup was margin-based, not structural: it cleared at the *next* mount, so any leaked timer shorter than the mount gap would still fire. | adversarial | moot — harness removed |
| 5 | Only `document` was boot-bound; `location`, `history`, `localStorage`, `fetch`, `EventSource` stay late-bound. | adversarial | **no change** — see "rejected" |
| 6 | The commit message oversold the perf side: only the `#app` lookup is saved, while `rememberScroll`/`stickToBottom` still do two `log` lookups per paint. | complexity | **message corrected** |
| 7 | The `try/finally` restoring `globalThis.document` was unexplained. | complexity | **kept, with the reason**: it must restore when an assertion throws mid-test |

### How finding 1 was measured

The complexity pass instrumented `pendingTimers` to report, at each mount, how
many tracked ids were still live (`!t._destroyed`):

```
MOUNT tracked=0  stillLive=0
MOUNT tracked=4  stillLive=0
MOUNT tracked=10 stillLive=1      <- the OAuth test's 1200ms poll
MOUNT tracked=5  stillLive=0
```

The set was "every timer since the last mount", not pending ones: the wrapper
adds an id on schedule and removes it only on `clearTimeout`, so the many
already-fired ids made the loop look busy while sparing nothing it needed. With
the harness removed the file passed **25/25**, and the single genuine leak,
post-fix, paints into its own detached document and stops.

The adversarial pass reached the same place by coverage: the poll's 1200 ms is
longer than the gap between tests, so the clearing loop fired before the
callback could run — turning a bug that at least executed the code by accident
into code that executes never.

## What the reviewers verified rather than assumed

- **The regression test discriminates.** New test file against `dev`'s
  `app.js`: fails 5/5, always on the new test. Against the reviewed head:
  passes. It cannot pass vacuously — nothing but a paint can put "Other" into
  `mine`, and that assertion runs before the weaker emptiness check.
- **The conversion is complete.** `grep -n 'document\.'` finds only the binding
  and its four uses; no second DOM identity survives in the file.
- **No phone regression.** A WebView gives a module exactly one document, so
  `doc === document` there. The harness is the only place two exist.
- **The seam is right for this file.** `location.search` and
  `localStorage.getItem` are already boot-time values, while `history` methods
  are read at call time; `document` was the one ambient value breaking that
  convention by being read at paint time.

## The reproduction, and why the numbers disagree

The flake is a race on **total suite duration**, because the poll's 1200 ms
lands near the end of a ~1.9 s run. Neither reviewer could reproduce it at all,
and the author had measured 12/25 — both were true:

| conditions | suite duration | failures |
|---|---|---|
| unloaded | ~1890 ms | 0/55 |
| CPU held | 2000–2143 ms | **4/6** |
| fixed client, CPU held | 2326–2459 ms | 0/10 |
| adversarial reviewer | — | 0/30 |
| complexity reviewer | — | 0/25 |

Faster machines sit below the band; the phone sits well above it. That
instability is why the fix is structural rather than a timing tune, and why
"it does not reproduce" is not evidence that it is fixed.

## Rejected

**Finding 5 — bind every global.** Rejected as speculative: the failing channel
was the paint path's DOM target, and that is now closed. Binding `fetch`,
`EventSource` and `location` would mean touching `state` and every component for
a one-document app with no build step, to guard a class of bug that has occurred
once. The file's own convention (boot-time values vs. call-time globals) is the
seam; there is no second seam to add today.

**Injectable poll interval.** Suggested twice as a way to test the callback
body. Deferred rather than rejected: it is a real change to the client's shape,
it has nothing to do with test isolation, and it belongs with the coverage gap
below.

## Left open, deliberately

> **Closed by PR #16** (`test/oauth-poll-coverage`), which drives the poll's
> timer instead of waiting it out and covers the guard, the merge, the error
> path and the re-poll. The paragraph below is kept as the record of what the
> review knew at the time.

`pollOauth`'s callback body — the `!o || o.done || state.sheet !== 'oauth'`
guard, the `events` accumulation, and the error path — has no deterministic
test. It needs the real 1200 ms to reach, so covering it is a follow-up (an
injectable interval, or a test that waits the interval out once and asserts the
events merge without duplicating), not part of this PR. Before this change the
only execution in the suite was the accidental, destructive one; afterwards
there is none. That is not a regression in coverage so much as the removal of a
false appearance of it — but it is the one thing a future change to the poll
could break silently.

## Outcome

The merged change is `runtime/public/app.js` binding `doc` at boot (13 lines
changed), and `test/client.test.mjs` gaining the regression test (29 added). The
timer harness, the comment that taught a false invariant, and the perf
overstatement are all gone.

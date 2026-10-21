# Review — the mobile client and the rootfs builder

Three independent passes over `upstream/master..master`: a correctness pass and
a design pass in the author's own voice, and an adversarial pass by a model
that had not seen the reasoning. Every finding was re-checked against the
files and against the built artefacts.

**The headline: the rewrite re-derived the server's wire format from memory
instead of from the working implementation it replaced, and disagreed with it
in eight places.** The worst of them was not handling the frame the server
sends first — `bridge_snapshot` — so **the transcript was empty on every
launch, every reconnect and every session switch**, with no error anywhere.

The old `transcript.js` and `keys.js` were the executable specification of
the server's wire format. The rewrite threw them away and re-derived the
format incorrectly. That is the pattern to stop, and it is exactly what the
no-build choice leaves unprotected: a bundler would have given a type error;
without one, a mismatched field is a silent blank screen.

## What was found, and what it cost

| | defect | consequence |
|---|---|---|
| 1 | `bridge_snapshot` not handled | the transcript is empty, always |
| 2 | the pending flag cleared on the list, not the rendered entry | every user message stays at half opacity |
| 3 | the send-failure path marked the last entry | the wrong bubble turns red |
| 4 | `markdown()` treated every block after the first as code | the prose after a code fence renders as code |
| 5 | `open=${''}` is falsy as a DOM property | tool output never opens |
| 6 | `install-wifi.sh` started `$PKG/.MainActivity` | "Class not found" — the wireless install never starts the app |
| 7 | the smoke test queried the port from before the force-stop | the durability check could only ever fail |
| 8 | `bridge_pid` matched the test's own shell | the supervision check could only ever pass |
| 9 | the OAuth events are objects | `[object Object]`, and sign-in is impossible |
| 10 | the notice was set before the sheet that clears it | no confirmation that a key was saved |
| 11 | `/api/usage` and `/api/state` have different shapes, one field | the usage sheet is empty and the menu hint breaks |
| 12 | the model is `{provider, modelId}` | the top bar always shows "–" |
| 13 | the menu read values only the sheets that display them loaded | the menu is not the status page it claims to be |
| 14 | tools rendered in a block after the messages | the causal order of the transcript is gone |
| 15 | the scroll check ran after the DOM changed | one tall frame loses the bottom, permanently |
| 16 | a full re-render and a full markdown re-parse per delta | jank on a phone, per token |
| 17 | `post()` lost the retry | one transient failure loses the message |
| 18 | the inbox is a document, not an array | the "queued · N" counter is dead |
| 19 | the instrumentation test drove a deleted page | it can never pass |
| 20 | a missing manifest skipped the appId check | a rootfs for another id can ship unchecked |
| 21 | "New session" posted the reset route | it wiped the conversation it was in |

Plus, from the adversarial pass: the compressed-file guard covered `.gz` and
nothing else; the OAuth poller outlived the sheet; and the preload comment
claimed a necessity that does not exist at targetSdk 28.

## What was NOT wrong, and was checked

- **No XSS path.** Every untrusted value — model text, tool output, provider
  and session names, OAuth events — reaches the DOM as a Preact text child.
  There is no `dangerouslySetInnerHTML` and no `innerHTML` anywhere.
- **The token does not leak.** It is stripped from the address bar with a
  `replaceState` that keeps the other parameters, the server compares it with
  `timingSafeEqual`, `hostAllowed` rejects a rebound Host, and the server
  never logs a URL.
- **The byte patch holds.** The built tree has 22 `app.pidabl` strings and
  **zero** `com.termux`; npm's shebang is `#!/data/data/app.pidabl/.../env node`.
  The 21 remaining `com.termux` strings are Termux's own *Android package*
  names, which are correct to keep.
- **The index lock is a real pin**, and it pins the debs transitively,
  because their hashes come from the pinned index.
- **The `LD_PRELOAD` env var names are real**, and the prefix inside the
  preload library was rewritten to ours.
- **`/api/thinking` works**: `configure({thinkingLevel})` writes the agent doc,
  and it is the same call the model route uses.

## What the design pass said to keep

Three decisions are right and should not be touched:

1. **One screen plus sheets.** The old client was a desktop application
   squeezed into a phone — a six-tab bottom nav, a `<select>` in the header, a
   `<dialog>` modal. Restyling it would have meant rewriting every page
   anyway. What the rewrite bought is real.
2. **No build step**, because the rootfs has no toolchain, the runtime is
   served from disk, and the file the agent edits on the phone really is the
   file that runs. The cost is that compile-time checking is gone — which is
   why the client test below is not optional.
3. **The rootfs builder's shape**: the assertions after the rewrite, the
   format-blindness check, the index lock, and the appId guard on both sides.

## The one thing that was missing

A test. The client now has one:

```
node --test 'test/*.test.mjs'
```

It mounts the real `runtime/public/app.js` in a DOM and feeds it the frames
the server really sends, then asserts on what the user would see. It catches
findings 1, 2, 4, 5, 9, 13, 14 and the markdown and ordering bugs. The
dependencies live in a root `package.json`, not `runtime/package.json`:
runtime's is what ships inside the APK.

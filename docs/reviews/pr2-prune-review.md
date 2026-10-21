# Review — PR #2 `chore: prune to a phone-only app`

**Scope:** `chore/prune-unused-subsystems` @ `59bfd54`, against `master` @ `48dac56`.
**Merged:** squash-merged as `c354e2e`; the reviewed head `59bfd54` and the
fixes `f9180f3` are in the pull request's history, not in `master`.
29 files, +396 / −16,598. Two independent passes (adversarial, design/complexity),
both on `opencode-go/minimax-m3.1-flash-free` at max thinking, plus the author's
own checks. The branches were reviewed in a worktree at `/tmp/pr2-review`.

**Verdict, from both passes:** the *cut* is right — the server genuinely got
simpler (883 → 534 lines) and the removed subsystems' only entry points were
pages deleted in `42bc8cc6`. But the change is **not mergeable as it stands**:
the Android app does not compile, and the PR's central safety claim names a
branch and a tag that do not exist.

## Blocking

### B1 — the Android app does not compile

`android/app/src/main/java/org/pimobile/app/SpaceKeyStore.java` is deleted, but
`PiService.java` still references the class in four places:

- `:48` — `private SpaceKeyStore spaceKeys;`
- `:58` — `spaceKeys = new SpaceKeyStore(this)` (on the service's start path)
- `:131` — `env.put("PI_SPACES_KEY_SOCKET", SpaceKeyStore.socketName());`
- `:294` — `spaceKeys.close()` in `onDestroy`

Proven with `javac` against `android-35`: three `cannot find symbol` errors.
`master` compiles clean, so the deletion is the sole cause.

`NoClassDefFoundError` is an `Error`, not an `Exception`, so the `catch (Exception e)`
at `:58` would not have caught it either: the class must go, not merely be kept.

**Fix:** delete the four references and the `PI_SPACES_KEY_SOCKET` env entry,
then `./gradlew assembleDebug` and confirm an APK comes out.

### B2 — "parked, not lost" is false

The claim appears in the commit message, the PR body, and `README.md:126-130`
and `README.md:290`, and it names `feature/remote-subsystem` and the tag
`pre-prune-2026-10-21`.

Neither exists. The repository has **no tags at all**
(`gh api .../git/refs/tags` → 404), and the branch is not on the remote. The
README's own recovery command fails:

```
$ git checkout feature/remote-subsystem -- runtime/remote-client.mjs
fatal: invalid reference: feature/remote-subsystem
```

The code itself is not lost: it is in `master`'s history at `48dac56` and in
`upstream/master`. But the documented recovery path does not work, and a
squash-merge of the PR into `master` would make the named refs permanently
unrecoverable-by-name.

**Fix:** either push the refs (`git branch feature/remote-subsystem 48dac56`,
`git tag -a pre-prune-2026-10-21 48dac56`) or rewrite the three places to name
`48dac56` and `git show 48dac56:runtime/remote-client.mjs`.

## Non-blocking, worth fixing

1. **The C1 fallback was swept, not decided.** `docs/pi-durable-android-oss-review.md:1638`
   says *keep* `remote-env.mjs` + `env-server.mjs` (322 lines) — the plan's §1.5
   remote-execution fallback — and `docs/plan-revision.md` §1.5 says the fork
   *has* it. The PR deletes both, so §1.5 is now factually wrong about the
   tree. `envFor` (`runtime/server.mjs:89-97`) survives as a seam with nothing
   to swap in. Either restore the 322 lines, or record the drop in the plan.
2. **The rootfs still ships the desktop machinery.** `scripts/package-rootfs.ts:112-113`
   still installs `openssh` and `util-linux`, and `:133` still hard-requires
   `usr/bin/ssh` — the PTY and the SSH host registry were the only callers.
3. **`common.mjs` did not shrink, and what stayed is dead.** `createEventHub`
   (`common.mjs:304`, ~80 lines) has no callers left; `sessionStore.remove` and
   `sessionStore.update` have none either. `createEventHub` is the plan's §1.9
   `seq` watermark implementation, so it is either worth finishing into the SSE
   server or worth deleting — leaving it advertised in `README.md:137` as a live
   part of the bridge is the one option that is wrong.
4. **A `models.json` entry can take the bridge down at boot.**
   `createModelCatalog` calls `applyModelsConfig` with no `try/catch`, and
   `server.mjs:85` awaits it at module top level, outside any `try`. A provider
   whose `getModels()` throws aborts module evaluation: the bridge never
   listens, the supervisor restarts it forever, and the phone has no agent —
   while `README.md:100-102` promises the opposite. pi-ai wraps exactly these
   calls in `try/catch`.
5. **The patched `provider.getModels` freezes the catalog.**
   `models-config.mjs:133-134` captures the base list at boot, so a later
   `models.refresh()` (reached from `/api/auth` and after an OAuth login) is
   invisible. The CLI's equivalent composes a *new* provider and re-reads the
   base inside the closure.
6. **A feature landed inside a `chore:` prune.** `models-config.mjs` +
   `test/models-config.test.mjs` is +273 lines of new behaviour, which forces
   the changelog to carry two unrelated things. The repository's idiom is one
   small focused change per commit.
7. **Stale documentation.** `README.md:470-478` and `README.md:505-523` still
   document `env-server`, `remotes.json`, `start_server.sh`, `pi-serverd`, the
   Spaces page and the Android Keystore key — none of which exist any more.
   `.gitignore:17` still lists `/runtime/space-examples/`.
8. **Test coverage gaps.** `agentConfigDir()` — the function that decides where
   `models.json` is read from — is never called by any test; the `getAllModels`
   patch is never asserted; nothing tests against the real pi-ai catalog; and
   no test pins the client↔server route table.

## Verified correct

- **The client↔server contract holds.** Every `/api/...` path the client calls
  is still served; the fifteen removed routes (`/api/remote/*`, `/api/clients`,
  `/api/sshkey`, `/api/pi-version`, `/api/pi-update-status`, `/api/result`,
  `/api/sessions/{delete,fork,rename}`) are all desktop-only, and the client
  calls none of them. `runtime/public/` is untouched, which is correct: the
  client is a passive view.
- **The pruned bridge boots.** `npm ci` from the new lockfile succeeds (90
  packages, no `ws`/`xterm`/`pi-coding-agent`), and the server serves `/`,
  `/app.js`, the SSE stream (`bridge_connected` + `bridge_snapshot`),
  `/api/state`, and answers 401 without a token and 421 on a bad host.
- **Removed routes 404 cleanly** against a live pruned server.
- **Packaging agrees with the tree.** `scripts/prepare-runtime.py`'s `FILES`
  list matches `runtime/` exactly, and the generated payload contains exactly
  those.
- **No dangling imports**; every relative specifier outside `node_modules`
  resolves.
- **The surviving behaviour is byte-identical to `master`.** The diff on
  `runtime/server.mjs` is deletions plus two changed constants. The owner lock,
  the SSE attach path, the token check and the credential store are untouched.
- **A real win:** `master:runtime/common.mjs` had a static re-export of the
  704 KB `pi-spaces.mjs`, which `server.mjs` imported — so it really was parsed
  on every phone boot. That is gone.
- The suite is green: 18/18.

# The `gh` tool

`scripts/gh` is a small GitHub CLI for this fork. It exists because the real
`gh` is a Go binary with a large surface, and because the people who will
review a pull request here are **agents**: they need machine-readable output
and a tool that does not need a login flow.

It is a single dependency-free Node file (`scripts/gh.mjs`) and a shell
launcher next to it. Node 22.19+ and `git` are all it needs — both are on the
phone.

```sh
scripts/gh pr create --title "..." --body "..." --base dev --push
scripts/gh pr list --state open --json number,title,url
scripts/gh pr view 12 --comments
scripts/gh pr comments 12 --since 2026-10-21T12:00:00Z
scripts/gh pr diff 12
scripts/gh pr comment 12 --body "one line about what is wrong"
scripts/gh pr checks 12
scripts/gh api GET /repos/RRiboulet/pidabl/pulls --field state=open
scripts/gh pr create --repo jeamy/pi-termux-mobile --title "..." --base master --push
scripts/gh repo view
scripts/gh auth status
```

`--base dev` is the rule for this repository (its default branch is `master`,
which takes releases only); the `jeamy` line shows the flag when the target
really is another repository's `master`.

To type `gh` instead of `scripts/gh`:

```sh
mkdir -p ~/bin && ln -s "$PWD/scripts/gh" ~/bin/gh
```

A pull request into another repository -- the upstream, say -- is opened with
`--repo owner/name`. The head then names the fork: `RRiboulet:branch`.

## Authentication

The token is looked for in this order:

1. `GH_TOKEN`
2. `GITHUB_TOKEN`
3. `~/.config/gh/token` (mode 0600)

A fine-grained token with **pull requests: read & write** and **contents: read
& write** is enough. Reading a public repository needs no token at all, so
`gh repo view`, `gh pr list` and `gh pr diff` work unauthenticated.

The token is never written into the repository, into `.git/config`, or into the
remote URL. `gh pr create --push` pushes over HTTPS with a one-shot askpass
helper that reads `$GH_TOKEN` from the environment, so the token appears in
neither the process arguments nor any file on disk.

Two things it does *not* do, so that they are not assumed:

- The token is in the **environment of the `git push` child**, because that is
  how the askpass helper reads it. Any process of the same user can read
  `/proc/<pid>/environ` while the push runs. The push runs with
  `--no-verify`, so a `pre-push` hook in the checkout -- which is somebody
  else's code -- never runs and never sees it.
- The token is **never sent to a host you name**. `gh api` takes a *path*,
  and a path starts with `/`; an absolute URL is refused. The credential goes
  to the API origin and nowhere else.

```sh
mkdir -p ~/.config/gh && chmod 700 ~/.config/gh
printf '%s' "$TOKEN" > ~/.config/gh/token && chmod 600 ~/.config/gh/token
```

## For agents reviewing a pull request

- `gh pr diff <n>` — the diff, as text, to read.
- `gh pr view <n> --comments` — the description and the review thread.
- `gh pr comments <n>` — every comment, from all three places GitHub keeps
  them: the conversation, the diff (inline review comments) and the review
  submissions. `--since <timestamp>` keeps only the new ones, which is how
  a review round is followed.
- `gh pr list --json number,title,state,head,base,url` — one JSON array, no
  prose. A field that is not there comes back as `null`, never as a missing
  key, so the JSON always has the same shape.
- `gh pr comment <n> --body "..."` — leave a review note. The tool prints the
  comment's URL, which is what a human or an agent should quote in a reply.
- `gh api GET <path> --field k=v` — the escape hatch for anything the tool
  does not wrap. On `GET`/`HEAD` a field becomes a query parameter, because
  the API rejects a body on those verbs. The path is a path: it starts with
  `/`, and a URL is refused, so the token cannot be pointed at another host.

A command refuses a flag it does not take: `gh pr view 1 --push` is an error,
not a flag that is quietly ignored.

**Errors** go to stderr as one JSON object, `{"error":{"kind":...,"message":
...}}`, and the exit code says the class: `2` auth, `3` not found, `4`
transport, `5` usage or API error. A failure is never a success with a
message.

**Output** is JSON where a machine reads it (`--json`, and `gh api`), and
prose where a human does. Text that came from GitHub -- a title, a body, a
comment -- is printed with the escape sequences removed, so a pull request
cannot drive the terminal of the agent that reads it.

Lists are followed to the end, through the pages GitHub paginates; if the
list is longer than the bound, stderr says so.

There is no colour, no spinner and no prompt: the tool never asks a
question, so it can run unattended.

## What it does not do

No issue tracker, no releases, no gists, no workflow runs, no `gh repo clone`
with credentials, no GraphQL. `gh api` is the way through to anything else.

## Tests

```sh
node test/gh-tool.test.mjs
node test/gh-tool-commands.test.mjs
```

They cover the parts that are easy to get quietly wrong: reading `owner/repo`
out of a remote URL, the field projection, the query-vs-body rule for `GET`,
and the property that the push helper never writes the token down.

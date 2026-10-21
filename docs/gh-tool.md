# The `gh` tool

`scripts/gh` is a small GitHub CLI for this fork. It exists because the real
`gh` is a Go binary with a large surface, and because the people who will
review a pull request here are **agents**: they need machine-readable output
and a tool that does not need a login flow.

It is a single dependency-free Node file (`scripts/gh.mjs`) and a shell
launcher next to it. Node 22.19+ and `git` are all it needs — both are on the
phone.

```sh
scripts/gh pr create --title "..." --body "..." --base master --push
scripts/gh pr list --state open --json number,title,url
scripts/gh pr view 12 --comments
scripts/gh pr comments 12 --since 2026-10-21T12:00:00Z
scripts/gh pr diff 12
scripts/gh pr comment 12 --body "one line about what is wrong"
scripts/gh pr checks 12
scripts/gh api GET /repos/RRiboulet/pi-termux-mobile/pulls --field state=open
scripts/gh pr create --repo jeamy/pi-termux-mobile --title "..." --base master --push
scripts/gh repo view
scripts/gh auth status
```

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
  the API rejects a body on those verbs.

Everything that prints structured data prints JSON. There is no colour, no
spinner and no prompt: the tool never asks a question, so it can run
unattended.

## What it does not do

No issue tracker, no releases, no gists, no workflow runs, no `gh repo clone`
with credentials, no GraphQL. `gh api` is the way through to anything else.

## Tests

```sh
node test/gh-tool.test.mjs
```

They cover the parts that are easy to get quietly wrong: reading `owner/repo`
out of a remote URL, the field projection, the query-vs-body rule for `GET`,
and the property that the push helper never writes the token down.

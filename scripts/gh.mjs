#!/usr/bin/env node
// gh.mjs — a small GitHub CLI, for phones and for agents.
//
// The real `gh` is a Go binary with a lot of surface. This is the part that
// matters for a fork that is reviewed by other agents: create a pull request,
// read it, comment on it, and fetch its diff. Everything it does, it does
// over the plain REST API with a token from the environment.
//
//   scripts/gh pr create --title "..." --body "..." [--base main] [--push]
//   scripts/gh pr list [--state open] [--json number,title,url]
//   scripts/gh pr view <n> [--comments] [--json ...]
//   scripts/gh pr diff <n>
//   scripts/gh pr comment <n> --body "..."
//   scripts/gh pr checks <n>
//   scripts/gh api <METHOD> <path> [--field k=v]
//   scripts/gh repo view
//   scripts/gh auth status
//
// Authentication, in the order it is looked for:
//   GH_TOKEN, GITHUB_TOKEN, then ~/.config/gh/token (mode 0600).
// The token is never written to the repository, to .git/config, or to disk by
// this script. `gh pr create --push` pushes over HTTPS with a one-shot
// askpass helper that reads the token from the environment, so the token does
// not appear in the remote URL, in the process arguments, or in .git/config.
// It does appear in the environment of the `git push` child (that is how the
// askpass helper reads it), so the push runs with --no-verify: a pre-push
// hook in a checkout that is not ours must not be handed the token.
//
// The token is sent to one origin only, the API this tool is pointed at, and
// never to a host a caller names. A path is a path: it starts with "/".

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const API_ORIGIN = new URL(API).origin;
const USER_AGENT = 'gh.mjs (pi-termux-mobile fork)';
const TIMEOUT_MS = 30_000;

// ── argument parsing ────────────────────────────────────────────────────────

const GLOBAL_OPTIONS = {
  'repo': { type: 'string' },
  'json': { type: 'string' },
  'field': { type: 'string', multiple: true },
  'raw': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'help': { type: 'boolean', short: 'h' },
};

const OPTIONS = {
  ...GLOBAL_OPTIONS,
  'base': { type: 'string' },
  'head': { type: 'string' },
  'commit': { type: 'string' },
  'title': { type: 'string' },
  'body': { type: 'string' },
  'body-file': { type: 'string' },
  'draft': { type: 'boolean' },
  'label': { type: 'string', multiple: true },
  'state': { type: 'string' },
  'push': { type: 'boolean' },
  'comments': { type: 'boolean' },
  'since': { type: 'string' },
};

export function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  return { values, positionals };
}

/**
 * The options each command takes.
 *
 * One flat table meant that a flag belonging to another command parsed fine
 * and was then ignored: `pr checks 12 --repo other/thing` read the fork
 * instead, and exited 0. For an agent that is the worst failure there is --
 * it believes it read what it did not read. A command now refuses a flag it
 * does not understand.
 */
export const ACCEPTS = {
  'api': ['repo', 'json', 'field', 'raw', 'dry-run'],
  'repo view': ['repo', 'json'],
  'pr create': ['repo', 'json', 'base', 'head', 'title', 'body', 'body-file', 'draft', 'label', 'push', 'dry-run'],
  'pr list': ['repo', 'json', 'state'],
  'pr view': ['repo', 'json', 'comments'],
  'pr comments': ['repo', 'json', 'since'],
  'pr diff': ['repo'],
  'pr comment': ['repo', 'body', 'body-file'],
  'pr checks': ['repo', 'commit'],
  'auth status': [],
};

/** Refuse an option the command does not take. */
export function checkAccepted(command, values) {
  const accepted = new Set(ACCEPTS[command] ?? []);
  for (const key of Object.keys(values)) {
    if (key === 'help') continue;
    if (!accepted.has(key)) {
      throw new Error(`${command} does not take --${key}`);
    }
  }
}

// ── the repository ──────────────────────────────────────────────────────────

/** owner/repo from the git remote, so the tool works inside any checkout. */
export function repoFromRemote(remote = 'origin', cwd = process.cwd(), { push = false } = {}) {
  let url = '';
  try {
    // The push URL is the one a push goes to: `git remote set-url --push` is a
    // standard way to set up a fork, and the fetch URL then names the
    // upstream, which is not where the branch goes.
    const args = push ? ['remote', 'get-url', '--push', remote] : ['remote', 'get-url', remote];
    url = execFileSync('git', args, { cwd, encoding: 'utf8', timeout: TIMEOUT_MS }).trim();
  } catch {
    throw new Error(`no git remote "${remote}" here (run this inside a clone)`);
  }
  const https = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  const ssh = /^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  const match = https || ssh;
  // The URL is not printed: it can carry a credential of its own.
  if (!match) throw new Error(`cannot read owner/repo from the remote URL (${redact(url)})`);
  return { owner: match[1], repo: match[2] };
}

// ── the token ───────────────────────────────────────────────────────────────

export function tokenFilePath(env = process.env) {
  return path.join(env.HOME || homedir(), '.config', 'gh', 'token');
}

/**
 * A GitHub token: printable ASCII, no spaces, no control characters.
 * A token with a newline in it is not a token, and passing one to fetch
 * throws an error whose message contains the header value -- which would put
 * the token in the agent's transcript.
 */
const TOKEN_RE = /^[A-Za-z0-9_.\-]{8,255}$/;

export function readToken({ required = true } = {}) {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  let token = env && env.trim() ? env.trim() : '';
  if (!token) {
    const file = tokenFilePath();
    try {
      token = readFileSync(file, 'utf8').trim();
    } catch { /* no token file */ }
  }
  if (!token) {
    if (!required) return undefined;
    throw new Error(
      'no GitHub token. Looked at: $GH_TOKEN, $GITHUB_TOKEN, ' +
      `${tokenFilePath()} (which does not exist or is empty). ` +
      'Create it with: umask 077; mkdir -p "$(dirname ' + tokenFilePath() + ')"; ' +
      `printf '%s' 'YOUR_TOKEN' > ${tokenFilePath()}; chmod 600 ${tokenFilePath()}. ` +
      'A fine-grained token with "pull requests: read & write" and "contents: read & write" is enough.',
    );
  }
  if (!TOKEN_RE.test(token)) {
    // The value is never printed, not even in part.
    throw new Error('the GitHub token does not look like a token (expected 8-255 characters of A-Z a-z 0-9 _ . -)');
  }
  return token;
}

/** Replace anything that looks like a token in text that is about to be printed. */
export function redact(text) {
  return String(text ?? '').replace(/\b(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '<token>');
}

// ── the API ─────────────────────────────────────────────────────────────────

/**
 * The URL for an API path.
 *
 * The path must be a path. An absolute URL here would send the token to
 * whoever wrote it, and "evil.example/x" would build the host
 * "api.github.comevil.example" -- a name in the attacker's own domain. The
 * tool only ever talks to the API it is pointed at.
 */
export function apiUrl(pathname, query) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) {
    throw new Error(`a GitHub API path starts with "/", got "${String(pathname).slice(0, 80)}"`);
  }
  const url = new URL(`${API}${pathname}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function api(method, pathname, { token, body, query, headers = {}, raw = false } = {}) {
  const url = apiUrl(pathname, query);
  // The credential goes to the API origin and nowhere else. If the origin is
  // ever something else, the request still goes out, but unauthenticated.
  const sameOrigin = new URL(url).origin === API_ORIGIN;
  const init = {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'accept': 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
      ...(token && sameOrigin ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!response.ok) {
    const message = parsed?.message
      ?? (typeof parsed === 'string' ? parsed : text.slice(0, 400))
      ?? `HTTP ${response.status}`;
    const detail = parsed?.errors?.length ? ` (${JSON.stringify(parsed.errors)})` : '';
    const error = new Error(`${method} ${pathname} -> ${response.status}: ${redact(message)}${redact(detail)}`);
    error.status = response.status;
    error.kind = response.status === 401 || response.status === 403 ? 'auth' : response.status === 404 ? 'not_found' : 'api';
    throw error;
  }
  if (raw) return text;
  return parsed;
}

/**
 * Every page of a list endpoint.
 *
 * GitHub paginates, and a list that stops at the first page looks exactly
 * like a list without the thing you were looking for. The Link header says
 * whether there is more; this follows it, up to a bound, and says so when it
 * stops early.
 */
export async function apiList(method, pathname, { token, query, headers = {}, maxPages = 10 } = {}) {
  const items = [];
  let next = pathname;
  let pages = 0;
  while (next && pages < maxPages) {
    const url = apiUrl(next, query);
    const sameOrigin = new URL(url).origin === API_ORIGIN;
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'accept': 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': USER_AGENT,
        ...(token && sameOrigin ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${method} ${next} -> ${response.status}: ${redact(text.slice(0, 400))}`);
      error.status = response.status;
      error.kind = response.status === 401 || response.status === 403 ? 'auth' : response.status === 404 ? 'not_found' : 'api';
      throw error;
    }
    let page = [];
    try { page = text ? JSON.parse(text) : []; } catch { /* not json */ }
    if (Array.isArray(page)) items.push(...page);
    const link = response.headers.get('link') ?? '';
    const match = /<([^>]+)>;\s*rel="next"/.exec(link);
    next = match ? new URL(match[1], API).pathname + new URL(match[1], API).search : null;
    pages += 1;
  }
  return { items, truncated: Boolean(next) };
}

// ── git, with a token that never touches disk ──────────────────────────────

/**
 * The askpass helper: it reads the token from the environment, so the token
 * is in no file, in no argument, and in no URL.
 */
export const ASKPASS_SOURCE = '#!/bin/sh\ncase "$1" in\n  *sername*) echo x-access-token ;;\n  *assword*) printf "%s\\n" "$GH_TOKEN" ;;\nesac\n';

/**
 * Push with the token from the environment, through a one-shot askpass helper.
 * The helper reads $GH_TOKEN, so the token is not in argv, not in the remote
 * URL, and not in .git/config.
 *
 * The push runs with --no-verify: a pre-push hook in the checkout would
 * inherit the environment the token is in, and the checkout is, by
 * construction, somebody else's code.
 */
export function pushWithToken(remote, branch, token, { cwd = process.cwd() } = {}) {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'gh-askpass-'));
  const helper = path.join(dir, 'askpass.sh');
  writeFileSync(helper, ASKPASS_SOURCE, { mode: 0o700 });
  chmodSync(helper, 0o700);
  const env = { ...process.env, GH_TOKEN: token, GIT_ASKPASS: helper, GIT_TERMINAL_PROMPT: '0' };
  try {
    // Push the named branch, not HEAD: the branch the pull request is for does
    // not have to be the one that is checked out.
    const result = spawnSync('git', ['-c', 'credential.helper=', 'push', '--no-verify', remote, `${branch}:${branch}`], {
      env, stdio: 'inherit', cwd, timeout: TIMEOUT_MS,
    });
    if (result.status !== 0) throw new Error(`git push failed (${result.status})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The branch the checkout is on, or a clear reason why there is not one. */
export function currentBranch(cwd = process.cwd()) {
  let onBranch = '';
  try {
    // git's own stderr is silenced: this tool's errors are JSON on stderr,
    // and git's "fatal: ..." would arrive in the middle of them.
    onBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd, encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not on a branch: is there a commit at all?
    try {
      execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8', timeout: TIMEOUT_MS });
    } catch {
      throw new Error('the checkout has no commit yet');
    }
    throw new Error('the checkout is on a detached HEAD: check out the branch you mean to push');
  }
  return onBranch;
}

/** A branch name that git will not read as an option. */
export function checkBranchName(name, what = 'branch') {
  const value = String(name ?? '').trim();
  if (!value) throw new Error(`no ${what} given`);
  if (value.startsWith('-')) throw new Error(`a ${what} name cannot start with "-"`);
  if (!/^[A-Za-z0-9._\-\/]+$/.test(value)) throw new Error(`"${value}" is not a ${what} name`);
  return value;
}

/** The commit the remote has for a branch, or null. */
export function remoteSha(remote, branch, cwd = process.cwd()) {
  const result = spawnSync('git', ['ls-remote', '--heads', remote, branch], { cwd, encoding: 'utf8', timeout: TIMEOUT_MS });
  const line = (result.stdout ?? '').trim().split('\n')[0] ?? '';
  return line ? line.split('\t')[0] : null;
}

/** The commit the local checkout has for a branch, or null. */
export function localSha(branch, cwd = process.cwd()) {
  const result = spawnSync('git', ['rev-parse', branch], { cwd, encoding: 'utf8', timeout: TIMEOUT_MS });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Whether the remote is behind the local branch.
 * "The branch exists on the remote" is not the question: a branch that is
 * there but three commits behind still has to be pushed, and a pull request
 * opened against the stale one would be reviewed in the wrong state.
 */
export function needsPush(remote, branch, cwd = process.cwd()) {
  const local = localSha(branch, cwd);
  // No local branch means nothing to push -- and it means the pull request
  // would be opened against a branch that does not exist here.
  if (!local) throw new Error(`there is no local branch named "${branch}"`);
  const remoteCommit = remoteSha(remote, branch, cwd);
  return remoteCommit !== local;
}

// ── output ─────────────────────────────────────────────────────────────────

/**
 * Escape sequences out of text that came from somewhere else.
 *
 * This tool prints other people's text by design: a pull request body, a
 * review comment, a diff. Printed raw, that text can clear the screen,
 * rewrite the line it is on, or set the terminal title -- so whoever can
 * open a pull request can drive the terminal of every agent that reads it.
 */
export function stripEscapes(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')           // CSI
    .replace(/\x1b[@-Z\\-_]/g, '')                        // other escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');   // C0, but not \t or \n
}

/** Untrusted text, safe to print: no escapes, and no carriage returns either. */
export function safeText(value) {
  return stripEscapes(value).replace(/\r/g, ' ');
}

/** A projection of an object: "number,title,url" -> { number, title, url }. */
export function project(value, fields) {
  if (!fields) return value;
  const wanted = fields.split(',').map((f) => f.trim()).filter(Boolean);
  if (!wanted.length) return value;
  const one = (item) => Object.fromEntries(wanted.map((f) => [f, item?.[f] ?? null]));
  return Array.isArray(value) ? value.map(one) : one(value);
}

function print(value) {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') { console.log(value); return; }
  console.log(JSON.stringify(value, null, 2));
}

// ── the commands ───────────────────────────────────────────────────────────

async function commandApi(values, positionals) {
  const [method, pathname] = positionals;
  if (!method || !pathname) throw new Error('usage: gh api <METHOD> <path>');
  const body = {};
  for (const field of values.field ?? []) {
    const at = field.indexOf('=');
    if (at === -1) throw new Error(`--field expects key=value, got "${field}"`);
    const key = field.slice(0, at);
    const raw = field.slice(at + 1);
    let parsed = raw;
    if (raw === 'true') parsed = true;
    else if (raw === 'false') parsed = false;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) parsed = Number(raw);
    body[key] = parsed;
  }
  const token = readToken({ required: false });
  const verb = method.toUpperCase();
  // A GET cannot carry a body: its fields are query parameters, like `gh api -f`.
  const query = {};
  if (verb === 'GET' || verb === 'HEAD') {
    for (const [key, value] of Object.entries(body)) query[key] = value;
  }
  if (values['dry-run']) {
    console.log(JSON.stringify({
      method: verb,
      url: apiUrl(pathname, query),
      headers: { authorization: token ? 'Bearer <token>' : '(none)' },
      body: verb === 'GET' || verb === 'HEAD' ? undefined : (Object.keys(body).length ? body : undefined),
    }, null, 2));
    return;
  }
  const result = await api(verb, pathname, {
    token,
    body: verb === 'GET' || verb === 'HEAD' ? undefined : (Object.keys(body).length ? body : undefined),
    query,
  });
  if (values.raw && result && typeof result === 'object') {
    console.log(JSON.stringify(result));
  } else {
    print(result);
  }
}

async function commandRepo(values) {
  const { owner, repo } = targetRepo(values);
  const token = readToken({ required: false });
  const result = await api('GET', `/repos/${owner}/${repo}`, { token });
  if (values.json) { print(project(result, values.json)); return; }
  print({
    full_name: result.full_name,
    default_branch: result.default_branch,
    private: result.private,
    url: result.html_url,
  });
}

async function commandPrList(values) {
  const { owner, repo } = targetRepo(values);
  const token = readToken({ required: false });
  const state = values.state ?? 'open';
  const { items, truncated } = await apiList('GET', `/repos/${owner}/${repo}/pulls`, {
    token,
    query: { state, per_page: '100' },
  });
  const rows = items.map((pr) => ({
    number: pr.number,
    title: safeText(pr.title),
    state: pr.state,
    draft: pr.draft,
    head: pr.head?.ref,
    base: pr.base?.ref,
    url: pr.html_url,
    updated: pr.updated_at,
  }));
  if (truncated) console.error('gh: the list was truncated; more pull requests exist than are shown');
  if (values.json) {
    print(project(rows, values.json));
    return;
  }
  if (!rows.length) { console.log('no pull requests'); return; }
  for (const row of rows) {
    console.log(`#${row.number} ${row.state === 'open' ? (row.draft ? 'draft' : 'open') : row.state} ${row.title}  [${row.head} -> ${row.base}]`);
  }
}

/**
 * Every comment on a pull request, from all three places GitHub keeps them:
 * the conversation (issue comments), the diff (inline review comments), and
 * the review submissions themselves. A reviewer working on the diff leaves
 * inline comments, so reading only the conversation would miss most of it.
 */
export async function collectComments({ owner, repo, number }, token, { api: apiFn = api } = {}) {
  const headers = { accept: 'application/vnd.github+json' };
  const [conversation, inline, reviews] = await Promise.all([
    apiFn('GET', `/repos/${owner}/${repo}/issues/${number}/comments`, { token, query: { per_page: '100' }, headers }),
    apiFn('GET', `/repos/${owner}/${repo}/pulls/${number}/comments`, { token, query: { per_page: '100' }, headers }),
    apiFn('GET', `/repos/${owner}/${repo}/pulls/${number}/reviews`, { token, query: { per_page: '100' }, headers }),
  ]);
  const out = [];
  for (const c of conversation ?? []) {
    out.push({ kind: 'conversation', user: safeText(c.user?.login), created: c.created_at, body: safeText(c.body), path: null, line: null });
  }
  for (const c of inline ?? []) {
    out.push({
      kind: 'inline',
      user: safeText(c.user?.login),
      created: c.created_at,
      body: safeText(c.body),
      path: c.path ?? null,
      line: c.line ?? c.original_line ?? null,
      in_reply_to: c.in_reply_to_id ?? null,
    });
  }
  for (const r of reviews ?? []) {
    out.push({
      kind: 'review',
      user: safeText(r.user?.login),
      created: r.submitted_at ?? r.created_at,
      body: safeText(r.body ?? ''),
      state: r.state,
      path: null,
      line: null,
    });
  }
  out.sort((a, b) => String(a.created ?? '').localeCompare(String(b.created ?? '')));
  return out;
}

/** The comments that arrived at or after a timestamp. */
export function commentsSince(comments, since) {
  const at = Date.parse(since);
  if (Number.isNaN(at)) throw new Error(`--since expects a timestamp, got "${since}"`);
  return comments.filter((c) => c.created && Date.parse(c.created) >= at);
}

async function commandPrComments(values, positionals) {
  const target = targetRepo(values);
  const token = readToken({ required: false });
  const number = prNumber(positionals[0]);
  let comments = await collectComments({ ...target, number }, token);
  if (values.since) comments = commentsSince(comments, values.since);
  if (values.json) { print(project(comments, values.json)); return; }
  if (!comments.length) { console.log('no comments'); return; }
  for (const c of comments) {
    const where = c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : '';
    const state = c.state ? ` [${c.state}]` : '';
    console.log(`--- ${c.kind} by ${c.user} at ${c.created}${state}${where}`);
    console.log(c.body ?? '');
    console.log('');
  }
}

/**
 * A pull request number.
 *
 * It goes into the API path, and a path that is not a path is a way to
 * address a different repository: "../../otherowner/otherrepo/issues/5" is
 * normalised by the URL parser into a path to somebody else's issue, and the
 * tool would report success. So the number is a number.
 */
export function prNumber(value) {
  const n = String(value ?? '').trim();
  if (!/^\d{1,10}$/.test(n)) {
    throw new Error(`a pull request number is a positive integer, got "${String(value ?? '').slice(0, 60)}"`);
  }
  return n;
}

async function commandPrView(values, positionals) {
  const { owner, repo } = targetRepo(values);
  const token = readToken({ required: false });
  const number = prNumber(positionals[0]);
  const pr = await api('GET', `/repos/${owner}/${repo}/pulls/${number}`, { token });
  if (values.comments) {
    const comments = await collectComments({ owner, repo, number }, token);
    pr.comments = comments.map((c) => ({
      kind: c.kind, user: c.user, created: c.created, body: c.body, path: c.path, line: c.line, state: c.state,
    }));
  }
  if (values.json) { print(project(pr, values.json)); return; }
  console.log(`#${pr.number} ${safeText(pr.title)}`);
  console.log(`state:   ${pr.state}${pr.draft ? ' (draft)' : ''}`);
  console.log(`branch:  ${pr.head?.ref} -> ${pr.base?.ref}`);
  console.log(`url:     ${pr.html_url}`);
  console.log(`author:  ${safeText(pr.user?.login)}`);
  console.log('');
  console.log(safeText(pr.body ?? ''));
  if (pr.comments?.length) {
    console.log('');
    console.log(`--- ${pr.comments.length} comment(s) ---`);
    for (const c of pr.comments) {
      const where = c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : '';
      console.log(`[${c.kind} ${c.user} ${c.created}${c.state ? ' ' + c.state : ''}${where}]\n${c.body}\n`);
    }
  }
}

async function commandPrDiff(values, positionals) {
  const { owner, repo } = targetRepo(values);
  const token = readToken({ required: false });
  const number = prNumber(positionals[0]);
  // Through api(), so the Authorization header is only there when there is a
  // token: a public repository needs none, and "Bearer undefined" is a 401.
  const diff = await api('GET', `/repos/${owner}/${repo}/pulls/${number}`, {
    token,
    headers: { accept: 'application/vnd.github.v3.diff' },
    raw: true,
  });
  console.log(stripEscapes(diff).trimEnd());
}

async function commandPrComment(values, positionals) {
  const { owner, repo } = targetRepo(values);
  const token = readToken();
  const number = prNumber(positionals[0]);
  const body = values.body ?? (values['body-file'] ? readFileSync(values['body-file'], 'utf8') : undefined);
  if (!body) throw new Error('a comment needs --body or --body-file');
  const result = await api('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { token, body: { body } });
  print({ url: result?.html_url, id: result?.id, created: result?.created_at });
}

async function commandPrChecks(values, positionals) {
  const { owner, repo } = targetRepo(values);
  const token = readToken();
  const number = prNumber(positionals[0]);
  // The checks of the pull request, not of whatever the checkout happens to
  // be on: the pull request is fetched first and its head commit is what is
  // asked about.
  const pr = await api('GET', `/repos/${owner}/${repo}/pulls/${number}`, { token });
  const commit = values.commit ?? pr?.head?.sha;
  if (!commit) throw new Error(`pull request #${number} has no head commit to check`);
  const result = await api('GET', `/repos/${owner}/${repo}/commits/${encodeURIComponent(commit)}/check-runs`, { token });
  const runs = result?.check_runs ?? [];
  if (!runs.length) { console.log('no check runs'); return; }
  for (const run of runs) console.log(`${run.status === 'completed' ? (run.conclusion ?? 'completed') : run.status}\t${safeText(run.name)}`);
}

async function commandPrCreate(values) {
  // The title is checked first: it is the cheapest thing to be wrong, and a
  // pull request with the title "Untitled" is worse than no pull request.
  if (!values.title) throw new Error('a pull request needs a --title');
  const target = targetRepo(values);
  // The head owner comes from the URL a push goes to, not from the URL a
  // fetch comes from: `git remote set-url --push` is how a fork is set up,
  // and the two disagree exactly when it matters.
  const origin = repoFromRemote('origin', process.cwd(), { push: true });
  const base = values.base ?? 'master';
  const branch = checkBranchName(values.head ?? currentBranch(), 'branch');
  // A pull request into another repository needs "forkowner:branch" as the head.
  const head = target.owner === origin.owner ? branch : `${origin.owner}:${branch}`;
  const body = values.body ?? (values['body-file'] ? readFileSync(values['body-file'], 'utf8') : '');
  const payload = { title: values.title, head, base, body, draft: Boolean(values.draft) };

  if (values['dry-run']) {
    const plan = { endpoint: `/repos/${target.owner}/${target.repo}/pulls`, method: 'POST', payload };
    if (values.push) {
      plan.push = { remote: 'origin', branch, needed: needsPush('origin', branch) };
    }
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const token = readToken();
  if (values.push) {
    if (needsPush('origin', branch)) {
      console.error(`pushing ${branch} to origin ...`);
      pushWithToken('origin', branch, token);
    } else {
      console.error(`${branch} is already up to date on origin`);
    }
  }

  const pr = await api('POST', `/repos/${target.owner}/${target.repo}/pulls`, { token, body: payload });
  // The pull request exists now, so the url is printed first: a failure after
  // this point must not read as "nothing happened", because the obvious
  // response to that is to create a second pull request.
  console.log(pr.html_url);
  const labels = values.label ?? [];
  if (labels.length) {
    try {
      await api('POST', `/repos/${target.owner}/${target.repo}/issues/${pr.number}/labels`, { token, body: { labels } });
    } catch (e) {
      console.error(`gh: the pull request was created (${pr.html_url}), but the labels could not be set: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

async function commandAuthStatus(values) {
  let token;
  try {
    token = readToken();
  } catch (e) {
    console.log(`token: none (${e.message})`);
    process.exitCode = 1;
    return;
  }
  const from = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) ? '$GH_TOKEN/$GITHUB_TOKEN' : tokenFilePath();
  console.log(`token: found in ${from} (${token.length} chars)`);
  try {
    const user = await api('GET', '/user', { token });
    console.log(`user:  ${user.login}`);
  } catch (e) {
    // A token that is not accepted is not a working token: say so in the exit
    // code, so an agent that gates on it does not believe it works.
    console.log(`user:  could not read the token: ${e.message}`);
    process.exitCode = 1;
  }
}

function usage() {
  console.log(`gh.mjs — a small GitHub CLI for this fork.

  gh pr create --title T [--body B | --body-file F] [--base B] [--head H] [--draft] [--label L] [--push]
  gh pr list [--state open|closed|all] [--json fields]
  gh pr view <n> [--comments] [--json fields]
  gh pr comments <n> [--since <timestamp>] [--json fields]
  gh pr diff <n>
  gh pr comment <n> --body "..."
  gh pr checks <n> [--commit <sha>]
  gh api <METHOD> <path> [--field k=v]
  gh repo view [--json fields]
  gh auth status

Token: GH_TOKEN, GITHUB_TOKEN, or ~/.config/gh/token (0600).
The repository is taken from the "origin" git remote, or from --repo owner/name.
Errors are printed on stderr as {"error":{"kind":...,"message":...}}; the exit
code says the kind: 2 auth, 3 not found, 4 transport, 5 usage.`);
}

/**
 * The repository the API talks to.
 * Without --repo it is the "origin" remote, which is the fork itself. With
 * --repo owner/name it is another repository -- the upstream, say -- which is
 * how a fork opens a pull request against the project it came from.
 */
export function targetRepo(values, cwd = process.cwd()) {
  if (values.repo) {
    const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(values.repo);
    if (!match) throw new Error(`--repo expects owner/name, got "${values.repo}"`);
    return { owner: match[1], repo: match[2] };
  }
  return repoFromRemote('origin', cwd);
}

export async function main(argv) {
  const { values, positionals } = parse(argv);
  if (values.help || positionals.length === 0) { usage(); return; }
  const [group, ...rest] = positionals;
  switch (group) {
    case 'api':
      checkAccepted('api', values);
      return commandApi(values, rest);
    case 'repo':
      if (rest[0] !== 'view') throw new Error(`unknown repo command: ${rest[0] ?? '(none)'}`);
      checkAccepted('repo view', values);
      return commandRepo(values);
    case 'pr':
      switch (rest[0]) {
        case 'create':
          checkAccepted('pr create', values);
          return commandPrCreate(values);
        case 'list':
          checkAccepted('pr list', values);
          return commandPrList(values);
        case 'view':
          checkAccepted('pr view', values);
          return commandPrView(values, rest.slice(1));
        case 'comments':
          checkAccepted('pr comments', values);
          return commandPrComments(values, rest.slice(1));
        case 'diff':
          checkAccepted('pr diff', values);
          return commandPrDiff(values, rest.slice(1));
        case 'comment':
          checkAccepted('pr comment', values);
          return commandPrComment(values, rest.slice(1));
        case 'checks':
          checkAccepted('pr checks', values);
          return commandPrChecks(values, rest.slice(1));
        default: throw new Error(`unknown pr command: ${rest[0] ?? '(none)'}`);
      }
    case 'auth':
      if (rest[0] !== 'status') throw new Error(`unknown auth command: ${rest[0] ?? '(none)'}`);
      checkAccepted('auth status', values);
      return commandAuthStatus(values);
    default: throw new Error(`unknown command: ${group}`);
  }
}

/**
 * The error channel.
 *
 * An agent's question is "did it work, and if not, what kind of not?". One
 * bit and a sentence to parse is not an answer, and the tool's own escape
 * hatch returns GitHub's JSON, so the wrapper used to be strictly less
 * machine-readable than the thing it wrapped. The error is a JSON envelope on
 * stderr, and the exit code says the class.
 */
export function errorEnvelope(error) {
  const kind = error?.kind
    ?? (error?.cause?.code || error?.code === 'ENOTFOUND' ? 'transport' : 'usage');
  return { error: { kind, message: redact(error?.message ?? String(error)) } };
}

const EXIT_CODES = { auth: 2, not_found: 3, transport: 4, api: 5, usage: 5 };

// Only run when invoked, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    const envelope = errorEnvelope(e);
    console.error(JSON.stringify(envelope));
    process.exit(EXIT_CODES[envelope.error.kind] ?? 1);
  });
}

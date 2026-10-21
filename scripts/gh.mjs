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

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const USER_AGENT = 'gh.mjs (pi-termux-mobile fork)';

// ── argument parsing ────────────────────────────────────────────────────────

const GLOBAL_OPTIONS = {
  'repo': { type: 'string' },
  'token': { type: 'string' },
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
  'title': { type: 'string' },
  'body': { type: 'string' },
  'body-file': { type: 'string' },
  'draft': { type: 'boolean' },
  'label': { type: 'string', multiple: true },
  'state': { type: 'string' },
  'limit': { type: 'string' },
  'push': { type: 'boolean' },
  'comments': { type: 'boolean' },
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

// ── the repository ──────────────────────────────────────────────────────────

/** owner/repo from the git remote, so the tool works inside any checkout. */
export function repoFromRemote(remote = 'origin', cwd = process.cwd()) {
  let url = '';
  try {
    url = execFileSync('git', ['remote', 'get-url', remote], { cwd, encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`no git remote "${remote}" here (run this inside a clone)`);
  }
  const https = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  const ssh = /^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  const match = https || ssh;
  if (!match) throw new Error(`cannot read owner/repo from the remote URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}

// ── the token ───────────────────────────────────────────────────────────────

export function readToken(explicit, { required = true } = {}) {
  if (explicit) return explicit.trim();
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env && env.trim()) return env.trim();
  const file = path.join(homedir(), '.config', 'gh', 'token');
  try {
    const token = readFileSync(file, 'utf8').trim();
    if (token) return token;
  } catch { /* no token file */ }
  if (!required) return undefined;
  throw new Error(
    'no GitHub token. Set GH_TOKEN, or write one to ~/.config/gh/token (chmod 600). ' +
    'A fine-grained token with "pull requests: read & write" and "contents: read & write" is enough.',
  );
}

// ── the API ─────────────────────────────────────────────────────────────────

export function apiUrl(pathname, query) {
  const url = new URL(pathname.startsWith('http') ? pathname : `${API}${pathname}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function api(method, pathname, { token, body, query, headers = {} } = {}) {
  const init = {
    method,
    headers: {
      'accept': 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(apiUrl(pathname, query), init);
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!response.ok) {
    const message = parsed?.message
      ?? (typeof parsed === 'string' ? parsed : text.slice(0, 400))
      ?? `HTTP ${response.status}`;
    const detail = parsed?.errors?.length ? ` (${JSON.stringify(parsed.errors)})` : '';
    throw new Error(`${method} ${pathname} -> ${response.status}: ${message}${detail}`);
  }
  return parsed;
}

// ── git, with a token that never touches disk ──────────────────────────────

/**
 * Push with the token from the environment, through a one-shot askpass helper.
 * The helper reads $GH_TOKEN, so the token is not in argv, not in the remote
 * URL, and not in .git/config.
 */
export function pushWithToken(remote, branch, token) {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'gh-askpass-'));
  const helper = path.join(dir, 'askpass.sh');
  writeFileSync(helper, '#!/bin/sh\ncase "$1" in\n  *sername*) echo x-access-token ;;\n  *assword*) printf "%s\\n" "$GH_TOKEN" ;;\nesac\n', { mode: 0o700 });
  chmodSync(helper, 0o700);
  const env = { ...process.env, GH_TOKEN: token, GIT_ASKPASS: helper, GIT_TERMINAL_PROMPT: '0' };
  try {
    const result = spawnSync('git', ['-c', 'credential.helper=', 'push', remote, `HEAD:${branch}`], {
      env, stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error(`git push failed (${result.status})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function currentBranch(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    throw new Error('not inside a git checkout');
  }
}

export function branchOnRemote(remote, branch, cwd = process.cwd()) {
  const result = spawnSync('git', ['ls-remote', '--heads', remote, branch], { cwd, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().length > 0;
}

// ── output ─────────────────────────────────────────────────────────────────

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
  const token = readToken(values.token, { required: false });
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
  const { owner, repo } = repoFromRemote();
  const token = readToken(values.token, { required: false });
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
  const { owner, repo } = repoFromRemote();
  const token = readToken(values.token, { required: false });
  const state = values.state ?? 'open';
  const result = await api('GET', `/repos/${owner}/${repo}/pulls`, {
    token,
    query: { state, per_page: values.limit ?? '30' },
  });
  const rows = result.map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft,
    head: pr.head?.ref,
    base: pr.base?.ref,
    url: pr.html_url,
    updated: pr.updated_at,
  }));
  if (values.json) {
    print(project(rows, values.json));
    return;
  }
  if (!rows.length) { console.log('no pull requests'); return; }
  for (const row of rows) {
    console.log(`#${row.number} ${row.state === 'open' ? (row.draft ? 'draft' : 'open') : row.state} ${row.title}  [${row.head} -> ${row.base}]`);
  }
}

async function commandPrView(values, positionals) {
  const { owner, repo } = repoFromRemote();
  const token = readToken(values.token, { required: false });
  const number = positionals[0];
  if (!number) throw new Error('usage: gh pr view <number>');
  const pr = await api('GET', `/repos/${owner}/${repo}/pulls/${number}`, { token });
  if (values.comments) {
    const comments = await api('GET', `/repos/${owner}/${repo}/issues/${number}/comments`, { token, query: { per_page: '100' } });
    pr.comments = comments.map((c) => ({ user: c.user?.login, created: c.created_at, body: c.body }));
  }
  if (values.json) { print(project(pr, values.json)); return; }
  console.log(`#${pr.number} ${pr.title}`);
  console.log(`state:   ${pr.state}${pr.draft ? ' (draft)' : ''}`);
  console.log(`branch:  ${pr.head?.ref} -> ${pr.base?.ref}`);
  console.log(`url:     ${pr.html_url}`);
  console.log(`author:  ${pr.user?.login}`);
  console.log('');
  console.log(pr.body ?? '');
  if (pr.comments?.length) {
    console.log('');
    console.log(`--- ${pr.comments.length} comment(s) ---`);
    for (const c of pr.comments) console.log(`[${c.user} ${c.created}]\n${c.body}\n`);
  }
}

async function commandPrDiff(values, positionals) {
  const { owner, repo } = repoFromRemote();
  const token = readToken(values.token, { required: false });
  const number = positionals[0];
  if (!number) throw new Error('usage: gh pr diff <number>');
  const response = await fetch(apiUrl(`/repos/${owner}/${repo}/pulls/${number}`, {}), {
    headers: {
      accept: 'application/vnd.github.v3.diff',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) throw new Error(`GET pull/${number} -> ${response.status}: ${await response.text()}`);
  console.log((await response.text()).trimEnd());
}

async function commandPrComment(values, positionals) {
  const { owner, repo } = repoFromRemote();
  const token = readToken(values.token);
  const number = positionals[0];
  const body = values.body ?? (values['body-file'] ? readFileSync(values['body-file'], 'utf8') : undefined);
  if (!number) throw new Error('usage: gh pr comment <number> --body "..."');
  if (!body) throw new Error('a comment needs --body or --body-file');
  const result = await api('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { token, body: { body } });
  print({ url: result?.html_url, created: result?.created_at });
}

async function commandPrChecks(values, positionals) {
  const { owner, repo } = repoFromRemote();
  const token = readToken(values.token);
  const number = positionals[0];
  if (!number) throw new Error('usage: gh pr checks <number>');
  const result = await api('GET', `/repos/${owner}/${repo}/commits/${values.head ?? 'HEAD'}/check-runs`, { token });
  const runs = result?.check_runs ?? [];
  if (!runs.length) { console.log('no check runs'); return; }
  for (const run of runs) console.log(`${run.status === 'completed' ? (run.conclusion ?? 'completed') : run.status}\t${run.name}`);
}

async function commandPrCreate(values) {
  const { owner, repo } = repoFromRemote();
  const base = values.base ?? 'master';
  const head = values.head ?? currentBranch();
  const body = values.body ?? (values['body-file'] ? readFileSync(values['body-file'], 'utf8') : '');
  const payload = { title: values.title ?? 'Untitled', head, base, body, draft: Boolean(values.draft) };

  if (values['dry-run']) {
    console.log(JSON.stringify({ endpoint: `/repos/${owner}/${repo}/pulls`, method: 'POST', payload }, null, 2));
    return;
  }

  const token = readToken(values.token);
  if (values.push) {
    if (!branchOnRemote('origin', head)) {
      console.error(`pushing ${head} to origin ...`);
      pushWithToken('origin', head, token);
    }
  }

  const pr = await api('POST', `/repos/${owner}/${repo}/pulls`, { token, body: payload });
  for (const label of values.label ?? []) {
    await api('POST', `/repos/${owner}/${repo}/issues/${pr.number}/labels`, { token, body: { labels: [label] } }).catch(() => {});
  }
  console.log(pr.html_url);
}

function commandAuthStatus(values) {
  try {
    const token = readToken(values.token);
    const user = api('GET', '/user', { token });
    console.log(`token: found (${token.slice(0, 4)}…, ${token.length} chars)`);
    user.then((u) => console.log(`user:  ${u.login}`)).catch((e) => console.log(`user:  could not read the token: ${e.message}`));
  } catch (e) {
    console.log(`token: none (${e.message})`);
    process.exitCode = 1;
  }
}

function usage() {
  console.log(`gh.mjs — a small GitHub CLI for this fork.

  gh pr create --title T [--body B | --body-file F] [--base B] [--head H] [--draft] [--label L] [--push]
  gh pr list [--state open|closed|all] [--limit N] [--json fields]
  gh pr view <n> [--comments] [--json fields]
  gh pr diff <n>
  gh pr comment <n> --body "..."
  gh pr checks <n>
  gh api <METHOD> <path> [--field k=v]
  gh repo view
  gh auth status

Token: GH_TOKEN, GITHUB_TOKEN, or ~/.config/gh/token (0600).
The repository is taken from the "origin" git remote.`);
}

export async function main(argv) {
  const { values, positionals } = parse(argv);
  if (values.help || positionals.length === 0) { usage(); return; }
  const [group, ...rest] = positionals;
  switch (group) {
    case 'api': return commandApi(values, rest);
    case 'repo': return commandRepo(values);
    case 'pr':
      switch (rest[0]) {
        case 'create': return commandPrCreate(values);
        case 'list': return commandPrList(values);
        case 'view': return commandPrView(values, rest.slice(1));
        case 'diff': return commandPrDiff(values, rest.slice(1));
        case 'comment': return commandPrComment(values, rest.slice(1));
        case 'checks': return commandPrChecks(values, rest.slice(1));
        default: throw new Error(`unknown pr command: ${rest[0] ?? '(none)'}`);
      }
    case 'auth': return commandAuthStatus(values);
    default: throw new Error(`unknown command: ${group}`);
  }
}

// Only run when invoked, not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`gh: ${e.message}`);
    process.exit(1);
  });
}

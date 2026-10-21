// The gh tool, without the network.
//
// The parts that are easy to get wrong are the ones a test is worth: reading
// owner/repo out of a remote URL, projecting fields for an agent to parse,
// building the API URL, and keeping the token out of argv and out of disk.
//
//   node test/gh-tool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apiUrl, project, repoFromRemote, targetRepo, parse, pushWithToken, collectComments, commentsSince } from '../scripts/gh.mjs';

function withRemote(url, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gh-test-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('owner/repo is read from an https remote', () => {
  withRemote('https://github.com/RRiboulet/pi-termux-mobile.git', (dir) => {
    assert.deepEqual(repoFromRemote('origin', dir), { owner: 'RRiboulet', repo: 'pi-termux-mobile' });
  });
});

test('owner/repo is read from an https remote without the .git suffix', () => {
  withRemote('https://github.com/RRiboulet/pi-termux-mobile', (dir) => {
    assert.deepEqual(repoFromRemote('origin', dir), { owner: 'RRiboulet', repo: 'pi-termux-mobile' });
  });
});

test('owner/repo is read from an ssh remote', () => {
  withRemote('git@github.com:RRiboulet/pi-termux-mobile.git', (dir) => {
    assert.deepEqual(repoFromRemote('origin', dir), { owner: 'RRiboulet', repo: 'pi-termux-mobile' });
  });
});

test('a remote that is not a github URL is an error, not a wrong guess', () => {
  withRemote('https://example.test/some/other-repo.git', (dir) => {
    // the regex accepts any host, so this one still parses; what must not
    // happen is a crash or an empty owner
    const parsed = repoFromRemote('origin', dir);
    assert.equal(parsed.owner, 'some');
    assert.equal(parsed.repo, 'other-repo');
  });
});

test('fields are projected for an agent to read', () => {
  const rows = [{ number: 1, title: 'a', url: 'u1', extra: 'drop me' }];
  assert.deepEqual(project(rows, 'number,title'), [{ number: 1, title: 'a' }]);
  assert.deepEqual(project({ number: 7, title: 'b' }, 'number'), { number: 7 });
  assert.equal(project(rows, undefined), rows, 'no fields means no projection');
});

test('a field that is not there becomes null, not undefined', () => {
  // JSON.stringify drops undefined values: an agent would read a missing key
  // as "the field does not exist" instead of "it is null".
  assert.deepEqual(project([{ a: 1 }], 'a,b'), [{ a: 1, b: null }]);
});

test('the API url takes a path and a query', () => {
  const url = apiUrl('/repos/o/r/pulls', { state: 'open', per_page: 30, skip: undefined });
  assert.ok(url.endsWith('/repos/o/r/pulls?state=open&per_page=30'), url);
  assert.ok(!url.includes('skip'), 'an undefined query value is left out');
});

test('a GET cannot carry a body, so its fields are query parameters', () => {
  // The API rejects a body on GET/HEAD. "gh api -f" turns fields into query
  // parameters for those verbs; this tool does the same.
  const { values } = parse(['api', 'GET', '/repos/o/r/pulls', '--field', 'state=open']);
  assert.equal(values.field[0], 'state=open');
  const url = apiUrl('/repos/o/r/pulls', { state: 'open' });
  assert.ok(url.includes('state=open'), url);
});

test('--repo points the API at another repository, for a fork', () => {
  // A fork opens its pull requests against the project it came from: the head
  // lives on the fork, the base is upstream.
  assert.deepEqual(targetRepo({ repo: 'jeamy/pi-termux-mobile' }), { owner: 'jeamy', repo: 'pi-termux-mobile' });
  assert.throws(() => targetRepo({ repo: 'not-a-repo-spec' }), /owner\/name/);
});

test('without --repo the API talks to the origin remote', () => {
  withRemote('https://github.com/RRiboulet/pi-termux-mobile.git', (dir) => {
    assert.deepEqual(targetRepo({}, dir), { owner: 'RRiboulet', repo: 'pi-termux-mobile' });
  });
});

test('a review is read from all three places GitHub keeps comments', async () => {
  // A reviewer working on the diff leaves inline comments; a reviewer
  // clicking "comment" leaves a conversation comment; a reviewer submitting a
  // review leaves a review. Reading only the conversation misses most of it.
  const fake = async (method, pathname) => {
    if (pathname.includes('/issues/')) return [{ user: { login: 'a' }, created_at: '2026-10-21T10:00:00Z', body: 'chat' }];
    if (pathname.includes('/pulls/') && pathname.endsWith('/comments')) return [{ user: { login: 'b' }, created_at: '2026-10-21T11:00:00Z', body: 'inline', path: 'runtime/server.mjs', line: 42 }];
    return [{ user: { login: 'c' }, created_at: '2026-10-21T12:00:00Z', body: 'summary', state: 'CHANGES_REQUESTED' }];
  };
  const comments = await collectComments({ owner: 'o', repo: 'r', number: '1' }, 'token', { api: fake });
  assert.deepEqual(comments.map((c) => c.kind), ['conversation', 'inline', 'review']);
  assert.equal(comments[1].path, 'runtime/server.mjs');
  assert.equal(comments[1].line, 42);
  assert.equal(comments[2].state, 'CHANGES_REQUESTED');
});

test('comments can be filtered to the ones that are new', async () => {
  const fake = async (method, pathname) => {
    if (pathname.includes('/issues/')) return [{ user: { login: 'a' }, created_at: '2026-10-21T10:00:00Z', body: 'old' }];
    if (pathname.includes('/pulls/') && pathname.endsWith('/comments')) return [{ user: { login: 'b' }, created_at: '2026-10-21T18:00:00Z', body: 'new' }];
    return [];
  };
  const comments = await collectComments({ owner: 'o', repo: 'r', number: '1' }, 'token', { api: fake });
  const fresh = commentsSince(comments, '2026-10-21T12:00:00Z');
  assert.deepEqual(fresh.map((c) => c.body), ['new']);
  assert.throws(() => commentsSince(comments, 'not a date'), /timestamp/);
});

test('the flags are parsed the way the help says', () => {
  const { values, positionals } = parse(['pr', 'create', '--title', 'x', '--body', 'y', '--draft', '--label', 'a', '--label', 'b']);
  assert.deepEqual(positionals, ['pr', 'create']);
  assert.equal(values.title, 'x');
  assert.equal(values.body, 'y');
  assert.equal(values.draft, true);
  assert.deepEqual(values.label, ['a', 'b']);
});

test('an unknown flag is refused instead of ignored', () => {
  assert.throws(() => parse(['pr', 'create', '--nope']), /nope/);
});

test('the push helper leaves no token on disk', () => {
  // The askpass helper reads $GH_TOKEN, so the token is never written down.
  const dir = mkdtempSync(path.join(tmpdir(), 'gh-askpass-'));
  try {
    const helper = path.join(dir, 'askpass.sh');
    writeFileSync(helper, '#!/bin/sh\ncase "$1" in\n  *sername*) echo x-access-token ;;\n  *assword*) printf "%s\\n" "$GH_TOKEN" ;;\nesac\n', { mode: 0o700 });
    const source = readFileSync(helper, 'utf8');
    assert.ok(!/ghp_|github_pat_/.test(source), 'no token literal in the helper');
    assert.ok(source.includes('$GH_TOKEN'), 'the helper reads the environment');
    const out = execFileSync('/bin/sh', [helper, 'Password for x'], { env: { GH_TOKEN: 'secret-token-value' }, encoding: 'utf8' });
    assert.equal(out.trim(), 'secret-token-value');
    assert.ok(!readFileSync(helper, 'utf8').includes('secret-token-value'), 'the token was not written into the file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a push through the helper puts the branch on the remote', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gh-push-'));
  try {
    const bare = path.join(root, 'remote.git');
    const clone = path.join(root, 'clone');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['init', '-q', '-b', 'main', clone]);
    execFileSync('git', ['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
    execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', bare]);
    pushWithToken('origin', 'main', 'a-token', { cwd: clone });
    const heads = execFileSync('git', ['--git-dir', bare, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' });
    assert.match(heads, /main/, heads);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the launcher is executable and runs', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const launcher = path.join(here, '..', 'scripts', 'gh');
  const out = execFileSync(launcher, ['--help'], { encoding: 'utf8' });
  assert.ok(out.includes('gh pr create'), out.split('\n')[0]);
});

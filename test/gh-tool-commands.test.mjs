// The gh tool, driven the way an agent drives it.
//
// The other test file covers the helpers. This one runs the commands
// themselves, against a local HTTP server, because the command layer is where
// the tool's promises live: that a pull request is created once, that the
// labels are applied, that a pull request number is a number, that the token
// is only ever sent to the API it is pointed at, and that a failure is
// reported as a failure.
//
//   node test/gh-tool-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nodeBinaryOrNode } from '../runtime/node-bin.mjs';

const tool = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'gh.mjs');
const { pushWithToken } = await import('../scripts/gh.mjs');

/**
 * A local server that records what it was asked for, and answers with
 * whatever the test says. GITHUB_API_URL points the tool at it, which is the
 * same seam a GitHub Enterprise install would use.
 */
async function withApi(handlers, fn) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const key = `${req.method} ${req.url.split('?')[0]}`;
      const handler = handlers[key];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      const answer = typeof handler === 'function' ? handler(req, body) : handler;
      const status = answer.status ?? 200;
      const payload = answer.body ?? {};
      const headers = { 'content-type': 'application/json', ...(answer.headers ?? {}) };
      res.writeHead(status, headers);
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn({ requests, port, base: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const execFileAsync = promisify(execFile);

/**
 * Run the tool.
 *
 * Asynchronous on purpose: the fake API is a server in this process, and a
 * synchronous child would block the event loop that has to answer it.
 */
async function run(args, { env = {}, cwd = process.cwd() } = {}) {
  const { stdout, stderr } = await execFileAsync(nodeBinaryOrNode(), [tool, ...args], {
    encoding: 'utf8',
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  return { stdout, stderr };
}

/** Run the tool, expecting it to fail, and return the error. */
async function runFails(args, { env = {}, cwd = process.cwd() } = {}) {
  try {
    await execFileAsync(nodeBinaryOrNode(), [tool, ...args], {
      encoding: 'utf8',
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
  } catch (e) {
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.code };
  }
  throw new Error('the tool exited 0, but it was expected to fail');
}

/** A checkout with an origin remote, so the tool can find a repository. */
async function withCheckout(fn, { url = 'https://github.com/RRiboulet/pi-termux-mobile.git' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gh-cmd-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the token ───────────────────────────────────────────────────────────────

test('the token is not sent to a host the caller names', async () => {
  const result = await runFails(['api', 'GET', 'http://127.0.0.1:1/collect'], { env: { GH_TOKEN: 'ghp_faketokenvalue' } });
  assert.match(result.stderr, /starts with/);
  assert.ok(!result.stdout.includes('ghp_faketokenvalue'), 'the token was printed');
});

test('a host-looking path is refused too', async () => {
  // "evil.example/x" would build the host "api.github.comevil.example".
  const result = await runFails(['api', 'GET', 'evil.example/x'], { env: { GH_TOKEN: 'ghp_faketokenvalue' } });
  assert.match(result.stderr, /starts with/);
});

test('the token goes to the API and to nowhere else', async () => {
  await withApi({ 'GET /user': { body: { login: 'someone' } } }, async ({ requests, base }) => {
    const result = await run(['auth', 'status'], { env: { GH_TOKEN: 'ghp_faketokenvalue', GITHUB_API_URL: base } });
    assert.match(result.stdout, /user:\s+someone/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.authorization, 'Bearer ghp_faketokenvalue');
  });
});

test('a request without a token carries no Authorization header', async () => {
  // The tool reads a token from ~/.config/gh/token as well as from the
  // environment, so "no token" has to mean a HOME that has none: the phone
  // this suite runs on has a real token in it.
  const home = mkdtempSync(path.join(tmpdir(), 'gh-home-'));
  try {
    await withApi({ 'GET /repos/RRiboulet/pi-termux-mobile/pulls/1': { body: { number: 1, title: 'x', head: { ref: 'a' }, base: { ref: 'b' } } } },
      async ({ requests, base }) => {
        await run(['pr', 'diff', '1'], { env: { GITHUB_API_URL: base, HOME: home } });
        // "Bearer undefined" is a 401 from GitHub: a public repository needs no
        // token, and the header must not be there at all.
        assert.equal(requests[0].headers.authorization, undefined);
      });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a token that is not a token is refused, and is not printed', async () => {
  const result = await runFails(['api', 'GET', '/user'], { env: { GH_TOKEN: 'has a space and\na newline' } });
  assert.match(result.stderr, /does not look like a token/);
  assert.ok(!result.stderr.includes('has a space'), 'the token was printed');
});

// ── the pull request number ─────────────────────────────────────────────────

test('a pull request number is a number', async () => {
  const result = await runFails(['pr', 'comment', '../../otherowner/otherrepo/issues/5', '--body', 'hello'],
    { env: { GH_TOKEN: 'ghp_faketokenvalue' } });
  assert.match(result.stderr, /positive integer/);
});

// ── creating a pull request ────────────────────────────────────────────────

test('a pull request is created and its labels are applied', async () => {
  const seen = [];
  await withApi({
    'POST /repos/RRiboulet/pi-termux-mobile/pulls': (req, body) => {
      seen.push(JSON.parse(body));
      return { body: { number: 42, html_url: 'https://github.com/RRiboulet/pi-termux-mobile/pull/42' } };
    },
    'POST /repos/RRiboulet/pi-termux-mobile/issues/42/labels': (req, body) => {
      seen.push(JSON.parse(body));
      return { body: [] };
    },
  }, async ({ base }) => {
    await withCheckout(async (dir) => {
      const result = await run(['pr', 'create', '--title', 'A title', '--body', 'A body', '--label', 'bug', '--label', 'needs-review'],
        { env: { GH_TOKEN: 'ghp_faketokenvalue', GITHUB_API_URL: base }, cwd: dir });
      assert.match(result.stdout, /pull\/42/);
      assert.equal(seen.length, 2, 'the labels endpoint was not called');
      assert.equal(seen[0].title, 'A title');
      assert.deepEqual(seen[1].labels, ['bug', 'needs-review']);
    });
  });
});

test('a pull request without a title is refused', async () => {
  const result = await runFails(['pr', 'create', '--body', 'A body'], { env: { GH_TOKEN: 'ghp_faketokenvalue' } });
  assert.match(result.stderr, /--title/);
});

test('the head of a cross-repository pull request names the fork', async () => {
  let payload = null;
  await withApi({
    'POST /repos/upstream/project/pulls': (req, body) => {
      payload = JSON.parse(body);
      return { body: { number: 7, html_url: 'https://github.com/upstream/project/pull/7' } };
    },
  }, async ({ base }) => {
    await withCheckout(async (dir) => {
      await run(['pr', 'create', '--title', 'T', '--body', 'B', '--repo', 'upstream/project'],
        { env: { GH_TOKEN: 'ghp_faketokenvalue', GITHUB_API_URL: base }, cwd: dir });
      assert.equal(payload.head, 'RRiboulet:main');
    });
  });
});

// ── checks ─────────────────────────────────────────────────────────────────

test('pr checks looks at the pull request, not at HEAD', async () => {
  const seen = [];
  await withApi({
    'GET /repos/RRiboulet/pi-termux-mobile/pulls/12': { body: { number: 12, head: { sha: 'deadbeef' } } },
    'GET /repos/RRiboulet/pi-termux-mobile/commits/deadbeef/check-runs': (req) => {
      seen.push(req.url);
      return { body: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] } };
    },
  }, async ({ base }) => {
    await withCheckout(async (dir) => {
      const result = await run(['pr', 'checks', '12'], { env: { GH_TOKEN: 'ghp_faketokenvalue', GITHUB_API_URL: base }, cwd: dir });
      assert.match(result.stdout, /success\s+build/);
      assert.equal(seen.length, 1);
      assert.match(seen[0], /deadbeef/);
    });
  });
});

// ── the option table ───────────────────────────────────────────────────────

test('a command refuses a flag it does not take', async () => {
  const result = await runFails(['pr', 'view', '1', '--push'], { env: { GH_TOKEN: 'ghp_faketokenvalue' } });
  assert.match(result.stderr, /pr view does not take --push/);
});

test('pr checks takes --repo and uses it', async () => {
  let seen = '';
  await withApi({
    'GET /repos/other/thing/pulls/3': { body: { number: 3, head: { sha: 'cafe' } } },
    'GET /repos/other/thing/commits/cafe/check-runs': (req) => { seen = req.url; return { body: { check_runs: [] } }; },
  }, async ({ base }) => {
    await run(['pr', 'checks', '3', '--repo', 'other/thing'], { env: { GH_TOKEN: 'ghp_faketokenvalue', GITHUB_API_URL: base } });
    assert.match(seen, /other\/thing\/commits\/cafe/);
  });
});

// ── untrusted text ─────────────────────────────────────────────────────────

test('text from a pull request cannot drive the terminal', async () => {
  const escape = '\x1b[31mRED\x1b[0m\x1b[2Jcleared\x07';
  await withApi({
    'GET /repos/RRiboulet/pi-termux-mobile/pulls/1': {
      body: { number: 1, title: escape, body: escape, head: { ref: 'a' }, base: { ref: 'b' }, user: { login: escape } },
    },
  }, async ({ base }) => {
    await withCheckout(async (dir) => {
      const result = await run(['pr', 'view', '1'], { env: { GITHUB_API_URL: base }, cwd: dir });
      assert.ok(!result.stdout.includes('\x1b'), 'an escape sequence reached the terminal');
      assert.ok(!result.stdout.includes('\x07'), 'a bell reached the terminal');
      assert.match(result.stdout, /RED/);
    });
  });
});

// ── the error channel ──────────────────────────────────────────────────────

test('a failure is a JSON envelope with a kind', async () => {
  await withApi({}, async ({ base }) => {
    const result = await runFails(['repo', 'view'], { env: { GH_TOKEN: 'ghp_faketokenvalue', GITHUB_API_URL: base } });
    const envelope = JSON.parse(result.stderr);
    assert.equal(envelope.error.kind, 'not_found');
    assert.equal(result.status, 3);
  });
});

test('auth status exits non-zero when the token is not accepted', async () => {
  await withApi({ 'GET /user': { status: 401, body: { message: 'Bad credentials' } } }, async ({ base }) => {
    const result = await runFails(['auth', 'status'], { env: { GH_TOKEN: 'ghp_faketokenvalue', GITHUB_API_URL: base } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /could not read the token/);
  });
});

// ── the push helper, for real ──────────────────────────────────────────────

test('the askpass helper that is really written has no token in it', async () => {
  // The old test wrote its own copy of the helper and asserted on that copy,
  // so it could not fail. This one captures the file the tool actually
  // writes, by standing a fake git in front of it.
  const root = mkdtempSync(path.join(tmpdir(), 'gh-fakegit-'));
  try {
    const bin = path.join(root, 'bin');
    const captured = path.join(root, 'captured-askpass.sh');
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncp "$GIT_ASKPASS" ${captured}\nexit 0\n`, { mode: 0o755 });
    const dir = mkdtempSync(path.join(tmpdir(), 'gh-push-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main', dir]);
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/o/r.git']);
      // The fake git has to be first on PATH: pushWithToken spawns "git".
      const oldPath = process.env.PATH;
      process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
      try {
        pushWithToken('origin', 'main', 'ghp_secretvalue', { cwd: dir });
      } finally {
        process.env.PATH = oldPath;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(existsSync(captured), 'the helper was not captured');
    const source = readFileSync(captured, 'utf8');
    assert.ok(!source.includes('ghp_secretvalue'), 'the token was written into the helper');
    assert.match(source, /\$GH_TOKEN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

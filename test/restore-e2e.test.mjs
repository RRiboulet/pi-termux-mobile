// A restore, following docs/backup-and-restore.md to the letter.
//
// A document that describes a recovery procedure nobody has run is a guess. This
// runs it: back up a live bridge, kill it, delete the database, extract the
// archive the way the document says, boot again, and check that the sessions and
// their text came back.
//
// The steps here are the document's steps, in the document's order. If this test
// has to change, the document is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeBinaryOrNode } from '../runtime/node-bin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot a bridge on this HOME and wait for its port file. */
async function boot(home) {
  const child = spawn(nodeBinaryOrNode(), ['runtime/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, PI_WORKDIR: path.join(home, 'work'), PI_SHELL: '/bin/bash',
      PREFIX: process.env.PREFIX || '', PI_TEST_FAUX: '1', PI_PROVIDER: 'faux', PI_MODEL: 'faux-1', PI_PORT: '' },
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const stateDir = path.join(home, '.pi-mobile');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !(existsSync(path.join(stateDir, 'port')) && existsSync(path.join(stateDir, 'token')))) await sleep(50);
  if (!existsSync(path.join(stateDir, 'port'))) {
    // Nothing worse than a failed boot that leaves a bridge running: it holds a
    // port and poisons the next run.
    child.kill('SIGKILL');
    throw new Error(`boot failed:\n${log}`);
  }
  const port = Number(readFileSync(path.join(stateDir, 'port'), 'utf8').trim());
  const token = readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  return {
    child, port, token, log: () => log,
    api: (p, opts = {}) => fetch(`http://127.0.0.1:${port}${p}`, {
      ...opts, headers: { 'x-token': token, 'content-type': 'application/json', ...(opts.headers || {}) },
    }),
    async stop() {
      // The document's first step: nothing may be writing to the database.
      child.kill('SIGTERM');
      const end = Date.now() + 8000;
      while (Date.now() < end && child.exitCode === null) await sleep(50);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/** The first `data:` frame of the given type on a fresh stream. */
async function frameOfType(port, token, type) {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/events?token=${token}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + 15000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.type === type) return ev;
      }
    }
    throw new Error(`no ${type} frame`);
  } finally {
    ac.abort();
  }
}

/** Run a command and fail loudly, the way a shell would. */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')}: ${out.trim()}`))));
  });
}

test('the documented restore brings a deleted database back', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'pi-restore-'));
  const marker = 'restore-me-4f9c';
  let id = null;
  let archive = null;
  try {
    // ── 1. Something worth losing ───────────────────────────────────────────
    {
      const b = await boot(home);
      try {
        await b.api('/api/prompt', { method: 'POST', body: JSON.stringify({ message: `say ${marker}` }) });
        await sleep(3500);
        const sessions = await (await b.api('/api/sessions')).json();
        id = sessions.sessions[0].id;
        const backup = await (await b.api('/api/backup', { method: 'POST' })).json();
        assert.equal(backup.started, true);
        // Keep the path: this is the file a user pulls off the phone.
        archive = backup.path;
        assert.ok(existsSync(archive));
      } finally {
        await b.stop();
      }
    }
    // ── 2. The loss ────────────────────────────────────────────────────────
    const db = path.join(home, '.pi-mobile', 'harness.sqlite');
    for (const f of [db, `${db}-wal`, `${db}-shm`]) if (existsSync(f)) rmSync(f);

    // ── 3. The document's steps 2-4, in its order ──────────────────────────
    // "Look at what you are about to restore."
    const listed = await run('tar', ['-tzf', archive]);
    assert.match(listed, /\.pi-mobile\/harness\.sqlite/, 'the archive does not hold the database where a restore expects it');
    assert.match(listed, /\.pi-mobile\/backup\.json/);
    // "Drop the database, including its write-ahead log."
    for (const f of [db, `${db}-wal`, `${db}-shm`]) if (existsSync(f)) rmSync(f);
    // "Restore: the archive is laid out relative to $HOME."
    await run('tar', ['-xzf', archive, '-C', home]);
    assert.ok(existsSync(db), 'the restore did not put the database back');

    // ── 4. It is really back ───────────────────────────────────────────────
    const b = await boot(home);
    try {
      const sessions = await (await b.api('/api/sessions')).json();
      assert.ok(sessions.sessions.some((s) => String(s.id) === String(id)),
        `session ${id} is not in the restored store: ${JSON.stringify(sessions.sessions)}`);
      const snap = await frameOfType(b.port, b.token, 'bridge_snapshot');
      const text = JSON.stringify(snap.snapshot.entries ?? []);
      assert.match(text, new RegExp(marker), 'the restored transcript has no text in it');
    } finally {
      await b.stop();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (archive) rmSync(archive, { force: true });
  }
});

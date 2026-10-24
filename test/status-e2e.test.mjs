// The status file the phone's notification is made of.
//
// Android cannot see inside node, and node cannot post a notification; the two
// share a file instead. PiService polls it to say "working · read" in the ongoing
// notification, and to notify when a turn ends while the app is in the background
// — which only works if this file is written with no client attached, so that is
// how the test reads it too (no SSE connection at any point).
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

test('the bridge writes what it is doing, with nobody watching', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pi-status-'));
  const home = path.join(tmp, 'home');
  const child = spawn(nodeBinaryOrNode(), ['runtime/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, PI_WORKDIR: path.join(home, 'work'), PI_SHELL: '/bin/bash',
      PREFIX: process.env.PREFIX || '', PI_TEST_FAUX: '1', PI_PROVIDER: 'faux', PI_MODEL: 'faux-1', PI_PORT: '' },
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const stateDir = path.join(home, '.pi-mobile');
  const statusFile = path.join(stateDir, 'status.json');
  const end = Date.now() + 60000;
  while (Date.now() < end && !existsSync(path.join(stateDir, 'port'))) await sleep(50);
  if (!existsSync(path.join(stateDir, 'port'))) {
    child.kill('SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`boot failed:\n${log}`);
  }
  const port = Number(readFileSync(path.join(stateDir, 'port'), 'utf8').trim());
  const token = readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  const api = (p, opts = {}) => fetch(`http://127.0.0.1:${port}${p}`, {
    ...opts, headers: { 'x-token': token, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const read = () => { try { return JSON.parse(readFileSync(statusFile, 'utf8')); } catch { return null; } };
  const until = async (want, ms = 20000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const st = read();
      if (st && want(st)) return st;
      await sleep(100);
    }
    throw new Error(`status never satisfied ${want}: ${JSON.stringify(read())}`);
  };

  try {
    // 1. Idle, before anything runs, and already naming the session.
    const idle = await until((s) => s.state === 'idle' && s.session);
    const state = await (await api('/api/state')).json();
    assert.equal(idle.session, String(state.sessionId), 'the status names a different session than /api/state');

    // 2. A turn starts: the file has to say so within a poll interval.
    await api('/api/prompt', { method: 'POST', body: JSON.stringify({ message: 'a turn worth noting' }) });
    const working = await until((s) => s.state === 'working');
    assert.ok(working.since > idle.since || working.state !== 'idle');

    // 3. And when it ends, a new finishedAt -- that is the notification trigger.
    const done = await until((s) => s.state === 'idle' && s.finishedAt > 0, 30000);
    assert.ok(done.finishedAt >= working.since, 'finishedAt is older than the run that produced it');
    assert.equal(done.tool, null);

    // 4. It stops rewriting the file when nothing changes (the poller compares
    //    before it writes, so an idle bridge is not a 2-second metronome).
    const before = readFileSync(statusFile, 'utf8');
    await sleep(3000);
    assert.equal(readFileSync(statusFile, 'utf8'), before, 'the status file is rewritten while nothing happens');
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    rmSync(tmp, { recursive: true, force: true });
  }
});

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

async function boot(env = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pi-wm-'));
  const child = spawn(nodeBinaryOrNode(), ['runtime/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HOME: path.join(tmp, 'home'), PI_WORKDIR: path.join(tmp, 'home', 'work'),
      PI_SHELL: '/bin/bash', PREFIX: path.join(tmp, 'prefix'), PI_TEST_FAUX: '1',
      PI_PROVIDER: 'faux', PI_MODEL: 'faux-1', ...env },
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const stateDir = path.join(tmp, 'home', '.pi-mobile');
  const ready = await (async () => { const end = Date.now() + 60000; while (Date.now() < end) { if (existsSync(path.join(stateDir, 'port')) && existsSync(path.join(stateDir, 'token'))) return true; await sleep(50); } return false; })();
  if (!ready) { child.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); throw new Error(`boot failed:\n${log}`); }
  const port = Number(readFileSync(path.join(stateDir, 'port'), 'utf8').trim());
  const token = readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  return { child, port, token, tmp, log: () => log, stop: async () => { child.kill('SIGTERM'); await sleep(200); rmSync(tmp, { recursive: true, force: true }); } };
}

/**
 * One SSE connection, read in the background into `frames`, so a test can wait
 * for the frame it cares about instead of sleeping for a fixed time.
 */
async function attach(port, token, since) {
  const ctl = new AbortController();
  const frames = [];
  const url = `http://127.0.0.1:${port}/api/events?token=${token}${since !== undefined ? `&since=${since}` : ''}`;
  const res = await fetch(url, { signal: ctl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try { frames.push(JSON.parse(line.slice(5).trim())); } catch {}
        }
      }
    } catch { /* cancelled */ }
  })();
  return { frames, cancel: () => ctl.abort() };
}

const isSnapshot = (f) => f.type === 'bridge_snapshot';
const seqOf = (f) => (typeof f.bridgeSeq === 'number' ? f.bridgeSeq : 0);
const highest = (frames) => frames.reduce((n, f) => Math.max(n, seqOf(f)), 0);

/** The first frame in `frames` that matches, from index `from` onwards. */
async function waitFor(frames, match, { from = 0, ms = 15000 } = {}) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = frames.find((f, i) => i >= from && match(f, i));
    if (hit) return hit;
    await sleep(25);
  }
  throw new Error(`no matching frame; saw ${JSON.stringify(frames.map((f) => f.type))}`);
}

/** Make the harness emit frames, and wait for one the attached client has not seen. */
async function traffic(b, live) {
  const before = highest(live.frames);
  const res = await fetch(`http://127.0.0.1:${b.port}/api/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': b.token },
    body: JSON.stringify({ message: 'hello', requestId: `wm-${Math.random().toString(36).slice(2)}` }),
  });
  assert.ok(res.ok, `the prompt was refused: ${res.status}`);
  return waitFor(live.frames, (f) => seqOf(f) > before);
}

test('a stale since yields gapped: true', async () => {
  const b = await boot();
  try {
    const live = await attach(b.port, b.token);
    const first = await waitFor(live.frames, isSnapshot);
    await traffic(b, live);
    live.cancel();
    // The client comes back claiming the watermark it had before that traffic.
    const back = await attach(b.port, b.token, first.bridgeSeq);
    const snap = await waitFor(back.frames, isSnapshot);
    assert.equal(snap.gapped, true, 'frames written while it was away should be a gap');
    back.cancel();
  } finally { await b.stop(); }
});

test('a current since yields gapped: false', async () => {
  const b = await boot();
  try {
    const live = await attach(b.port, b.token);
    const first = await waitFor(live.frames, isSnapshot);
    live.cancel();
    const back = await attach(b.port, b.token, highest(live.frames) || first.bridgeSeq);
    const snap = await waitFor(back.frames, isSnapshot);
    assert.equal(snap.gapped, false, 'a client that has seen everything is not gapped');
    // Both connections are this bridge run: the epoch is how a client tells one
    // run's counter from the last one's.
    const epochs = [...live.frames, ...back.frames].filter((f) => f.type === 'bridge_connected').map((f) => f.epoch);
    assert.equal(epochs.length, 2, 'both connections should have a bridge_connected frame');
    assert.equal(typeof epochs[0], 'string', 'bridge_connected should carry an epoch');
    assert.equal(epochs[0], epochs[1], 'the epoch should be stable within one bridge run');
    back.cancel();
  } finally { await b.stop(); }
});

test('a session switch is not a reconnect', async () => {
  const b = await boot();
  try {
    // Somebody else's traffic, so the counter is ahead of the watermark below.
    const live = await attach(b.port, b.token);
    await waitFor(live.frames, isSnapshot);
    await traffic(b, live);

    // A client that was away comes back behind: its first snapshot says so.
    const away = await attach(b.port, b.token, 1);
    const first = await waitFor(away.frames, isSnapshot);
    assert.equal(first.gapped, true, 'a client that was away should be told once');

    // Switching sessions re-attaches every client (runtime/server.mjs: activate),
    // and the client has been receiving since: it has no second gap to report.
    const from = away.frames.length;
    const res = await fetch(`http://127.0.0.1:${b.port}/api/sessions/new`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-token': b.token }, body: '{}',
    });
    assert.ok(res.ok, `the session switch was refused: ${res.status}`);
    const snap = await waitFor(away.frames, isSnapshot, { from });
    assert.equal(snap.gapped, false, 'a session switch reported a reconnect the client did not have');
    live.cancel();
    away.cancel();
  } finally { await b.stop(); }
});

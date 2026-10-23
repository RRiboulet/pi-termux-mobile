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

async function firstSnapshot(port, token, since) {
  const url = `http://127.0.0.1:${port}/api/events?token=${token}${since !== undefined ? `&since=${since}` : ''}`;
  const res = await fetch(url);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === 'bridge_snapshot') { reader.cancel(); return ev; }
    }
  }
  reader.cancel();
  throw new Error('no snapshot');
}

test('a stale since yields gapped: true', async () => {
  const b = await boot();
  try {
    // keep a draining client attached so traffic advances the watermark
    const res0 = await fetch(`http://127.0.0.1:${b.port}/api/events?token=${b.token}`);
    const reader0 = res0.body.getReader();
    const dec0 = new TextDecoder();
    let buf0 = '';
    const gotSnap = await new Promise((resolve) => {
      const deadline = Date.now() + 8000;
      const tick = async () => {
        if (Date.now() > deadline) return resolve(null);
        const { value, done } = await reader0.read();
        if (done) return resolve(null);
        buf0 += dec0.decode(value, { stream: true });
        let i;
        while ((i = buf0.indexOf('\n\n')) !== -1) {
          const c = buf0.slice(0, i); buf0 = buf0.slice(i + 2);
          const l = c.split('\n').find((x) => x.startsWith('data:'));
          if (!l) continue;
          const ev = JSON.parse(l.slice(5));
          if (ev.type === 'bridge_snapshot') return resolve(ev);
        }
        tick();
      };
      tick();
    });
    assert.ok(gotSnap, 'initial snapshot');
    // generate traffic while the draining client is attached
    await fetch(`http://127.0.0.1:${b.port}/api/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-token': b.token },
      body: JSON.stringify({ message: 'hello', requestId: 'wm-1' }),
    });
    await sleep(2000);
    // reconnect claiming we only saw seq 1 (stale)
    const snap1 = await firstSnapshot(b.port, b.token, 1);
    assert.equal(snap1.gapped, true, 'stale since should be gapped');
    reader0.cancel();
  } finally { await b.stop(); }
});

test('a current since yields gapped: false', async () => {
  const b = await boot();
  try {
    const snap0 = await firstSnapshot(b.port, b.token);
    const snap1 = await firstSnapshot(b.port, b.token, snap0.seq);
    assert.equal(snap1.gapped, false, 'current since should not be gapped');
  } finally { await b.stop(); }
});

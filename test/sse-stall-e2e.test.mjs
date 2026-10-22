// The one thing the unit tests cannot see: a real client that stops reading, a
// real socket, and a real bridge that has to notice -- and then keep serving.
//
// `sseStall` is tested directly and `enforceSseBudget` with a fake response,
// but both take the queue depth on trust. This boots the bridge the way the
// phone does and checks the whole path.
//
// The budget is one byte, so any queued byte counts, and the window is short
// but NOT zero: a zero window has no room to observe progress, so a client that
// is reading and merely bursty is dropped too. That is not hypothetical -- the
// first version of this file's control test proved it, with a reading client
// that queued 1,057,055 bytes and was dropped.
//
// There is also a physical limit worth knowing before reading the drop test:
// `writableLength` only grows once the kernel's socket buffer behind the client
// is full, so below that point the bridge has queued nothing worth noticing and
// it is right not to drop anyone. That is why the drop test keeps prompting
// until it happens instead of expecting it after one message, and why the loop
// is bounded by a deadline rather than by a count: the buffer's size is the
// host's business, not this file's.
//
// Booting the bridge dominates the run, which is why there is one boot for both
// tests.
//
//   node test/sse-stall-e2e.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeBinaryOrNode } from '../runtime/node-bin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for `done()` to be true, or give up. */
async function until(done, ms = 20_000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (done()) return true;
    await sleep(step);
  }
  return false;
}

/** Boot the bridge on an ephemeral port, with a throwaway HOME. */
async function bootBridge(env = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pi-sse-'));
  const child = spawn(nodeBinaryOrNode(), ['runtime/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: path.join(tmp, 'home'),
      PI_WORKDIR: path.join(tmp, 'home', 'work'),
      PI_SHELL: '/bin/bash',
      PREFIX: path.join(tmp, 'prefix'),
      PI_TEST_FAUX: '1',
      PI_PROVIDER: 'faux',
      PI_MODEL: 'faux-1',
      ...env,
    },
  });
  // nodeBinaryOrNode: on Android process.execPath is the dynamic linker.
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const stateDir = path.join(tmp, 'home', '.pi-mobile');
  // Generous on purpose: this runs on the phone too, where harness init is
  // slower than on any host.
  const ready = await until(() => existsSync(path.join(stateDir, 'port')) && existsSync(path.join(stateDir, 'token')), 60_000);
  if (!ready) { child.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); throw new Error(`the bridge did not start:\n${log}`); }
  const port = Number(readFileSync(path.join(stateDir, 'port'), 'utf8').trim());
  const token = readFileSync(path.join(stateDir, 'token'), 'utf8').trim();

  return {
    child, port, token,
    log: () => log,
    api: (p, opts = {}) => fetch(`http://127.0.0.1:${port}${p}`, {
      ...opts,
      headers: { 'x-token': token, 'content-type': 'application/json', ...(opts.headers || {}) },
    }),
    async stop() {
      child.kill('SIGTERM');
      await until(() => child.exitCode !== null, 5_000);
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Send the event-stream request on a socket, and say whether it opened. */
async function attach(port, token, { read = true } = {}) {
  const sock = net.connect(port, '127.0.0.1');
  sock.on('error', () => {});                 // a dropped client is destroyed; that is expected
  const status = await new Promise((resolve) => {
    sock.on('connect', () => sock.write(
      `GET /api/events?token=${token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
    sock.once('data', (d) => resolve(d.toString().split('\r\n')[0]));
    setTimeout(() => resolve('no response'), 5_000);
  });
  if (read) sock.on('data', () => {});        // keep draining, like a live page
  else sock.pause();                          // stop reading, like a suspended WebView
  return { sock, status };
}

const DROPPED = /sse: dropped a client that stopped reading/;
const drops = (log) => (log.match(/sse: dropped a client that stopped reading/g) ?? []).length;

// A message big enough that frames keep arriving. A short echo is a handful of
// tiny writes the kernel absorbs, so nothing would ever be queued here.
const BIG = 'x'.repeat(256 * 1024);

let shared = null;
const bridge = async () => (shared ??= await bootBridge({ PI_SSE_MAX_BUFFERED: '1', PI_SSE_STALL_MS: '500' }));
test.after(async () => { await shared?.stop(); shared = null; });

test('the bridge drops a client that stopped reading, and keeps serving', async () => {
  const b = await bridge();
  const stalled = await attach(b.port, b.token, { read: false });
  assert.match(stalled.status, /200/, `the event stream did not open: ${stalled.status}`);

  const posted = await b.api('/api/prompt', { method: 'POST', body: JSON.stringify({ message: BIG }) });
  assert.equal(posted.ok, true, `the prompt was refused: ${posted.status}`);

  // Keep sending until the socket buffer behind the paused client is full. One
  // message is not enough, and the reason is in the header: until the kernel
  // stops accepting, the queue keeps draining from this side and there is
  // genuinely nothing to notice. Bounded by a deadline, because how much the
  // buffer holds is the host's business -- a turn count would be a guess that
  // fails on a machine with a larger one.
  const deadline = Date.now() + 40_000;
  while (!DROPPED.test(b.log()) && Date.now() < deadline) {
    await b.api('/api/prompt', { method: 'POST', body: JSON.stringify({ message: BIG }) });
    await until(() => DROPPED.test(b.log()), 2_000);
  }

  assert.ok(DROPPED.test(b.log()),
    `the bridge never dropped the client that stopped reading:\n${b.log()}`);

  // The point of dropping is to survive it: a memory fix that takes the bridge
  // down with it is not a fix.
  assert.equal(b.child.exitCode, null, 'the bridge died when it dropped the client');

  // And the client that comes back gets served, which is what repairs the
  // transcript: a fresh stream and a fresh snapshot.
  const fresh = await attach(b.port, b.token);
  assert.match(fresh.status, /200/, `a reconnect after the drop was not served: ${fresh.status}`);
  fresh.sock.destroy();
  stalled.sock.destroy();
  assert.equal(drops(b.log()), 1, 'the stalled client was dropped more than once');
});

test('a client that keeps reading is never dropped', async () => {
  // The negative control: without it, a bridge that dropped every client would
  // pass the test above, and that is a worse bug than the one being fixed.
  // This is also the end-to-end test of the progress half of the rule -- the
  // queue here goes over a one-byte budget constantly, and is only saved by
  // shrinking within the window.
  const b = await bridge();
  const before = drops(b.log());
  const reading = await attach(b.port, b.token);
  assert.match(reading.status, /200/, `the event stream did not open: ${reading.status}`);

  const posted = await b.api('/api/prompt', { method: 'POST', body: JSON.stringify({ message: BIG }) });
  assert.equal(posted.ok, true);

  // Long enough for the stalled client's window to have elapsed many times over.
  await sleep(3_000);
  assert.equal(drops(b.log()), before, 'a client that was reading got dropped');
  assert.equal(b.child.exitCode, null, 'the bridge died while serving a healthy client');
  reading.sock.destroy();
});

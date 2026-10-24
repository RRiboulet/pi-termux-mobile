// Signing devices in, and the modes that let them reach the bridge at all.
//
// The old model was one token, in localStorage, in the EventSource URL, in every
// log line that saw the URL. What replaces it: per-device tokens stored hashed, an
// HttpOnly cookie, one-time pairing codes, rotation, and an access mode so a second
// device can reach the bridge without exposing it to the LAN by accident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { nodeBinaryOrNode } from '../runtime/node-bin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A GET with a Host header of our choosing: fetch() will not let us set one. */
function rawGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

async function boot(env = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pi-auth-'));
  const child = spawn(nodeBinaryOrNode(), ['runtime/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HOME: path.join(tmp, 'home'), PI_WORKDIR: path.join(tmp, 'home', 'work'),
      PI_SHELL: '/bin/bash', PREFIX: process.env.PREFIX || '', PI_TEST_FAUX: '1',
      PI_PROVIDER: 'faux', PI_MODEL: 'faux-1', PI_PORT: '', ...env },
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const stateDir = path.join(tmp, 'home', '.pi-mobile');
  const end = Date.now() + 60000;
  while (Date.now() < end && !(existsSync(path.join(stateDir, 'port')) && existsSync(path.join(stateDir, 'token')))) await sleep(50);
  if (!existsSync(path.join(stateDir, 'port'))) { child.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); throw new Error(`boot failed:\n${log}`); }
  const port = Number(readFileSync(path.join(stateDir, 'port'), 'utf8').trim());
  const token = readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  return {
    child, port, token, tmp, stateDir, log: () => log,
    /** fetch with a cookie jar of our own, the way a browser would behave. */
    async req(p, { method = 'GET', body, cookie = '', token: t } = {}) {
      const headers = { 'content-type': 'application/json' };
      if (cookie) headers.cookie = cookie;
      if (t) headers['x-token'] = t;
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = r.headers.get('set-cookie') || '';
      let json = null;
      try { json = await r.json(); } catch {}
      return { status: r.status, json, cookie: set.split(';')[0] };
    },
    stop: async () => { child.kill('SIGTERM'); await sleep(300); rmSync(tmp, { recursive: true, force: true }); },
  };
}

test('a token buys a cookie, and the cookie is what the API accepts', async () => {
  const b = await boot();
  try {
    // Nothing signed in: no cookie, no header, no query.
    assert.equal((await b.req('/api/state')).status, 401, 'the API answered without a credential');

    const exchange = await b.req('/api/session', { method: 'POST', body: { token: b.token } });
    assert.equal(exchange.status, 200);
    assert.match(exchange.cookie, /^pi=/, `no cookie was set: ${JSON.stringify(exchange.cookie)}`);
    assert.equal(exchange.json?.ok, true, 'the exchange did not say ok');

    // The header carries HttpOnly: the page's own script must not read it.
    const raw = await fetch(`http://127.0.0.1:${b.port}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: b.token }),
    });
    assert.match(String(raw.headers.get('set-cookie')), /HttpOnly/i, 'the cookie is readable by scripts');
    assert.match(String(raw.headers.get('set-cookie')), /SameSite=Strict/i);

    const state = await b.req('/api/state', { cookie: exchange.cookie });
    assert.equal(state.status, 200, 'the cookie was not accepted');

    // The old paths still work, because scripts and the e2e suite use them.
    assert.equal((await b.req('/api/state', { token: b.token })).status, 200);
    assert.equal((await b.req(`/api/state?token=${b.token}`)).status, 200);

    // A wrong token buys nothing.
    assert.equal((await b.req('/api/session', { method: 'POST', body: { token: 'nope' } })).status, 401);
  } finally { await b.stop(); }
});

test('a pairing code signs a second device in, once', async () => {
  const b = await boot();
  try {
    const pair = await b.req('/api/pair', { method: 'POST', token: b.token });
    assert.equal(pair.status, 200);
    assert.match(pair.json.url, /\?pair=/, 'the pairing URL does not carry the code');
    const code = new URL(pair.json.url).searchParams.get('pair');

    const claim = await b.req('/api/session', { method: 'POST', body: { code, name: 'laptop' } });
    assert.equal(claim.status, 200, `the code was refused: ${JSON.stringify(claim.json)}`);
    assert.match(claim.cookie, /^pi=/, 'the new device got no cookie');
    assert.equal((await b.req('/api/state', { cookie: claim.cookie })).status, 200);

    // The same code again is refused: it was one use.
    assert.equal((await b.req('/api/session', { method: 'POST', body: { code } })).status, 401);

    // The device list knows both, and never shows a token.
    const list = await b.req('/api/devices', { cookie: claim.cookie });
    assert.equal(list.status, 200);
    const names = list.json.devices.map((d) => d.name);
    assert.ok(names.includes('laptop'), `the new device is not listed: ${JSON.stringify(names)}`);
    assert.doesNotMatch(JSON.stringify(list.json), new RegExp(b.token), 'the API returned a token');
    // ...and the file on disk holds hashes, not secrets.
    const onDisk = readFileSync(path.join(b.stateDir, 'devices.json'), 'utf8');
    assert.doesNotMatch(onDisk, new RegExp(b.token), 'the bootstrap token is on disk in the clear');
  } finally { await b.stop(); }
});

test('rotating the token signs out everything but the caller', async () => {
  const b = await boot();
  try {
    const mine = await b.req('/api/session', { method: 'POST', body: { token: b.token } });
    const rotated = await b.req('/api/token/rotate', { method: 'POST', cookie: mine.cookie });
    assert.equal(rotated.status, 200);
    assert.ok(rotated.json.token && rotated.json.token !== b.token, 'the token did not change');

    // The caller gets a new cookie and keeps working; the old token does not.
    assert.match(rotated.cookie, /^pi=/, 'no cookie was issued to the caller');
    assert.equal((await b.req('/api/state', { cookie: rotated.cookie })).status, 200, 'the caller was signed out');
    assert.equal((await b.req('/api/state', { cookie: mine.cookie })).status, 401, 'the old cookie still works');
    assert.equal((await b.req('/api/state', { token: b.token })).status, 401, 'the old token still works');
    assert.equal((await b.req('/api/state', { token: rotated.json.token })).status, 200);
    assert.equal(readFileSync(path.join(b.stateDir, 'token'), 'utf8').trim(), rotated.json.token);
  } finally { await b.stop(); }
});

test('a Host that is not ours is refused, in every mode', async () => {
  const b = await boot();
  try {
    assert.equal(await rawGet(b.port, '/api/state', { host: 'evil.example', 'x-token': b.token }), 421, 'a rebinding Host was not refused');
    assert.equal(await rawGet(b.port, '/api/state', { host: `127.0.0.1:${b.port}`, 'x-token': b.token }), 200);
  } finally { await b.stop(); }
});

test('tailscale mode binds the tailnet address, or falls back to loopback', async () => {
  const b = await boot({ PI_ACCESS: 'tailscale', PI_HOSTNAME: 'phone.example.ts.net' });
  try {
    const devices = await b.req('/api/devices', { token: b.token });
    assert.equal(devices.json.access, 'tailscale');
    // A tailnet name with the port is allowed even though the socket is loopback.
    assert.equal(await rawGet(b.port, '/api/state', { host: `phone.example.ts.net:${b.port}`, 'x-token': b.token }), 200,
      'the configured hostname was refused');
    assert.equal(await rawGet(b.port, '/api/state', { host: `other.example:${b.port}`, 'x-token': b.token }), 421,
      'an unrelated Host was accepted in tailscale mode');
  } finally { await b.stop(); }
});

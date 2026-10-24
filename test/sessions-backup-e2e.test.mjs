// Sessions you can name and put away, and a backup you can pull off the phone.
//
// Both are about what a phone cannot get back: a list of sessions that only grows
// until it is unreadable, and a database that a reinstall deletes without asking
// (`files/home`, which is where the sessions AND the API keys live). One boot for
// both, because booting the bridge is what costs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { nodeBinaryOrNode } from '../runtime/node-bin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bridge = null;
async function boot() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pi-sess-'));
  const child = spawn(nodeBinaryOrNode(), ['runtime/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HOME: path.join(tmp, 'home'), PI_WORKDIR: path.join(tmp, 'home', 'work'),
      PI_SHELL: '/bin/bash', PREFIX: process.env.PREFIX || '', PI_TEST_FAUX: '1',
      PI_PROVIDER: 'faux', PI_MODEL: 'faux-1', PI_PORT: '' },
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
    child, port, token, tmp, log: () => log,
    api: (p, opts = {}) => fetch(`http://127.0.0.1:${port}${p}`, {
      ...opts, headers: { 'x-token': token, 'content-type': 'application/json', ...(opts.headers || {}) },
    }),
    stop: async () => { child.kill('SIGTERM'); await sleep(200); rmSync(tmp, { recursive: true, force: true }); },
  };
}
const b = async () => (bridge ??= await boot());
test.after(async () => { await bridge?.stop(); bridge = null; });

test('a session can be named, and the name is what the list shows', async () => {
  const bd = await b();
  const created = await (await bd.api('/api/sessions/new', { method: 'POST', body: '{}' })).json();
  const id = created.activeId;

  const renamed = await bd.api('/api/sessions/rename', { method: 'POST', body: JSON.stringify({ id, name: '  refactor the gate  ' }) });
  assert.equal(renamed.status, 200);
  const list = await (await bd.api('/api/sessions')).json();
  const row = list.sessions.find((s) => String(s.id) === String(id));
  assert.equal(row.name, 'refactor the gate', 'the name was not stored, or not trimmed');

  // An empty name goes back to the number the bridge shows.
  await bd.api('/api/sessions/rename', { method: 'POST', body: JSON.stringify({ id, name: '   ' }) });
  const again = await (await bd.api('/api/sessions')).json();
  assert.equal(again.sessions.find((s) => String(s.id) === String(id)).name, undefined, 'an empty name did not clear it');
});

test('a session can be archived and brought back, but not the open one', async () => {
  const bd = await b();
  const before = await (await bd.api('/api/sessions')).json();
  const openId = before.activeId;

  const refused = await bd.api('/api/sessions/archive', { method: 'POST', body: JSON.stringify({ id: openId }) });
  assert.equal(refused.status, 400, 'archiving the open session should be refused');

  // Another session, then archive it.
  const other = await (await bd.api('/api/sessions/new', { method: 'POST', body: '{}' })).json();
  await bd.api('/api/sessions/select', { method: 'POST', body: JSON.stringify({ id: openId }) });
  const archived = await bd.api('/api/sessions/archive', { method: 'POST', body: JSON.stringify({ id: other.activeId }) });
  assert.equal(archived.status, 200);
  let list = await (await bd.api('/api/sessions')).json();
  assert.equal(list.sessions.find((s) => String(s.id) === String(other.activeId)).archived, true, 'the archive flag is missing');

  // Archiving keeps the history: the session is still selectable by id.
  const chosen = await bd.api('/api/sessions/select', { method: 'POST', body: JSON.stringify({ id: other.activeId }) });
  assert.equal(chosen.status, 200, 'an archived session could not be opened');

  const restored = await bd.api('/api/sessions/archive', { method: 'POST', body: JSON.stringify({ id: other.activeId, archived: false }) });
  assert.equal(restored.status, 200);
  list = await (await bd.api('/api/sessions')).json();
  assert.equal(list.sessions.find((s) => String(s.id) === String(other.activeId)).archived, undefined, 'the flag was not cleared');
});

test('a backup is a readable archive of the database', async () => {
  const bd = await b();
  // Something worth backing up.
  await bd.api('/api/prompt', { method: 'POST', body: JSON.stringify({ message: 'a turn to back up' }) });
  await sleep(3500);

  const made = await bd.api('/api/backup', { method: 'POST' });
  assert.equal(made.status, 200);
  const info = await made.json();
  assert.equal(info.started, true, `the backup did not start: ${JSON.stringify(info)}`);
  assert.match(info.name, /^pi-backup-.*\.tar\.gz$/, 'the archive is not named as a backup');
  assert.ok(info.bytes > 1000, `the archive is only ${info.bytes} bytes`);
  assert.ok(existsSync(info.path), `no archive at ${info.path}`);

  // It has to be readable: a tarball of the database and the manifest.
  const tar = gunzipSync(readFileSync(info.path));
  assert.ok(tar.includes('harness.sqlite'), 'the database is not in the archive');
  assert.ok(tar.includes('backup.json'), 'the manifest is not in the archive');

  // And the list agrees with what is on disk.
  const listed = await (await bd.api('/api/backup')).json();
  assert.equal(listed.dir, path.dirname(info.path));
  assert.ok(listed.backups.some((x) => x.name === info.name), 'the new backup is not in the list');
  assert.ok(listed.backups[0].bytes > 0);
});

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
import { DatabaseSync } from 'node:sqlite';
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
  // The layout is a contract: paths are relative to $HOME, so restoring is one
  // `tar -xzf … -C files/home`. docs/backup-and-restore.md depends on this.
  assert.ok(tar.includes('.pi-mobile/harness.sqlite'), 'the database is not at the $HOME-relative path a restore needs');
  assert.ok(tar.includes('.pi-mobile/backup.json'), 'the manifest is not inside .pi-mobile');

  // And the list agrees with what is on disk.
  const listed = await (await bd.api('/api/backup')).json();
  assert.equal(listed.dir, path.dirname(info.path));
  assert.ok(listed.backups.some((x) => x.name === info.name), 'the new backup is not in the list');
  assert.ok(listed.backups[0].bytes > 0);
});

test('archived sessions can be purged, after a backup, and the rows are gone', async () => {
  const bd = await b();
  const before = await (await bd.api('/api/sessions')).json();
  const openId = before.activeId;

  // A session with a real transcript, then archived while another one is open.
  const created = await (await bd.api('/api/sessions/new', { method: 'POST', body: '{}' })).json();
  const id = created.activeId;
  await bd.api('/api/prompt', { method: 'POST', body: JSON.stringify({ message: 'a turn worth purging' }) });
  await sleep(3500);
  await bd.api('/api/sessions/select', { method: 'POST', body: JSON.stringify({ id: openId }) });
  const archived = await bd.api('/api/sessions/archive', { method: 'POST', body: JSON.stringify({ id }) });
  assert.equal(archived.status, 200);

  const planResponse = await bd.api('/api/sessions/purge');
  assert.equal(planResponse.status, 200);
  const plan = await planResponse.json();
  assert.ok(plan.ready.some((s) => String(s.id) === String(id)), 'the archived session is not a purge candidate');
  const candidate = plan.ready.find((s) => String(s.id) === String(id));
  assert.ok(candidate.entries > 0, 'the transcript has no entries to purge');
  assert.ok(!plan.skipped.some((s) => String(s.id) === String(id)), `the archived session was skipped: ${JSON.stringify(plan.skipped)}`);
  assert.ok(plan.dbBytes > 0);

  // The route refuses a request that did not carry the one confirmation.
  const refused = await bd.api('/api/sessions/purge', { method: 'POST', body: '{}' });
  assert.equal(refused.status, 400, 'a purge without confirm:true was accepted');

  // A session archived after the sheet's plan was read is not in the ids the
  // client sends, so it must survive even though it is now archived.
  const other = await (await bd.api('/api/sessions/new', { method: 'POST', body: '{}' })).json();
  await bd.api('/api/sessions/select', { method: 'POST', body: JSON.stringify({ id: openId }) });
  await bd.api('/api/sessions/archive', { method: 'POST', body: JSON.stringify({ id: other.activeId }) });

  const purged = await bd.api('/api/sessions/purge', {
    method: 'POST',
    body: JSON.stringify({ confirm: true, ids: plan.ready.map((s) => s.id) }),
  });
  assert.equal(purged.status, 200);
  const result = await purged.json();
  assert.ok(result.purged.some((s) => String(s.id) === String(id)), 'the candidate was not reported as purged');
  assert.ok(result.backup?.path && existsSync(result.backup.path), 'no backup was taken before the purge');
  assert.ok(result.freed >= 0, `the freed bytes are not a number: ${result.freed}`);
  assert.ok(result.dbBytes > 0, `the store size is not reported: ${result.dbBytes}`);

  // It is gone from the list, and from the store: the conversation, its entries
  // and its row in the id allocator's registry.
  const after = await (await bd.api('/api/sessions')).json();
  assert.ok(!after.sessions.some((s) => String(s.id) === String(id)), 'the purged session is still listed');
  const db = new DatabaseSync(path.join(bd.tmp, 'home', '.pi-mobile', 'harness.sqlite'));
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ?').get(Number(id)).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries WHERE conversation_id = ?').get(Number(id)).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM record_ids WHERE record_type = 'conversation' AND id = ?").get(Number(id)).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ?').get(Number(other.activeId)).n, 1, 'a session outside the confirmed ids was deleted');
  } finally {
    db.close();
  }
});

test('the open session is skipped, not purged', async () => {
  const bd = await b();
  const listed = await (await bd.api('/api/sessions')).json();
  const openId = listed.activeId;

  // Create a session, archive it, then open it again: it is archived, but a
  // device is looking at it, so it is not a purge candidate.
  const created = await (await bd.api('/api/sessions/new', { method: 'POST', body: '{}' })).json();
  const id = created.activeId;
  await bd.api('/api/sessions/select', { method: 'POST', body: JSON.stringify({ id: openId }) });
  await bd.api('/api/sessions/archive', { method: 'POST', body: JSON.stringify({ id }) });
  await bd.api('/api/sessions/select', { method: 'POST', body: JSON.stringify({ id }) });

  const plan = await (await bd.api('/api/sessions/purge')).json();
  assert.ok(!plan.ready.some((s) => String(s.id) === String(id)), 'an open archived session is a purge candidate');
  assert.ok(plan.skipped.some((s) => String(s.id) === String(id) && /open/.test(s.reason)), `the open session was not skipped: ${JSON.stringify(plan.skipped)}`);

  const purged = await (await bd.api('/api/sessions/purge', { method: 'POST', body: JSON.stringify({ confirm: true, ids: [id] }) })).json();
  assert.ok(!purged.purged.some((s) => String(s.id) === String(id)), 'an open session was purged');
  await bd.api('/api/sessions/select', { method: 'POST', body: JSON.stringify({ id: openId }) });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MobileSpaces } from '../runtime/spaces-mobile.mjs';

test('mobile pairing persists its identity before the effect and resolves a lost response after reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-pair-')), file = join(dir, 'profile.json'); let created = 0;
  const keys = { createAndroidSigner: async () => { created++; return { alias: 'native-alias', keyId: 'key', publicKey: 'public' }; } };
  const prepare = { peerId: 'phone', controlHostId: 'control', endpoint: 'tcp://100.1.2.3:4711' };
  try {
    const client = new MobileSpaces(file, keys); await client.call('prepare', prepare);
    client.connect = async () => ({ close() {}, remote: { info: async () => ({ spaceId: "control-space-id" }), enroll: async (token, options) => { const request = { generation: 'g', requestId: 'r' }; await options.beforeSend(request); assert.deepEqual(JSON.parse(readFileSync(file)).enrollment, request); assert.ok(!readFileSync(file, 'utf8').includes(token)); throw new Error('lost reply'); } } });
    await assert.rejects(client.call('enroll', { token: 'secret-token', controlSpaceId: 'wrong-control-space' }), /identity mismatch/);
    await assert.rejects(client.call('enroll', { token: 'secret-token', controlSpaceId: 'control-space-id' }), /lost reply/);
    const reopened = new MobileSpaces(file, keys); await assert.rejects(reopened.call('prepare', prepare), /already prepared/); assert.equal(created, 1);
    reopened.connect = async () => ({ close() {}, remote: { authenticate: async () => {}, enrollStatus: async request => { assert.deepEqual(request, { generation: 'g', requestId: 'r' }); return { state: 'done', result: { keyId: 'key', peerId: 'phone' } }; } } });
    assert.equal((await reopened.call('enrollStatus')).profile.state, 'paired'); assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a pending rotation is retained across reopen and activates the new alias only after a completed own command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-rotate-')), file = join(dir, 'profile.json');
  try {
    const client = new MobileSpaces(file, { createAndroidSigner: async () => ({ alias: 'replacement', keyId: 'new', publicKey: 'new-public', algorithm: 'ecdsa-p256' }) });
    client.save({ alias: 'old', keyId: 'old-key', peerId: 'phone', controlHostId: 'control', endpoint: 'tcp://100.1.2.3:4711', state: 'paired' });
    client.connect = async () => ({ close() {}, remote: { authenticate: async () => {}, rotationChallenge: async () => ({ nonce: 'nonce' }), rotateKey: async (_c, _k, options) => { await options.beforeSend({ generation: 'g', requestId: 'r' }); throw new Error('lost rotation reply'); } } });
    await assert.rejects(client.call('rotate'), /lost rotation reply/); assert.equal(client.read().alias, 'old');
    const reopened = new MobileSpaces(file, {}); await assert.rejects(reopened.call('rotate'), /pending rotation/);
    let completed = false; reopened.connect = async () => ({ close() {}, remote: { authenticate: async () => {}, rotationStatus: async id => { assert.equal(id, 'rotate:phone:nonce'); return { state: completed ? 'completed' : 'pending' }; } } });
    assert.equal((await reopened.call('rotationStatus')).profile.alias, 'old'); completed = true;
    assert.equal((await reopened.call('rotationStatus')).profile.alias, 'replacement'); assert.equal(reopened.read().rotation, undefined);
    const again = new MobileSpaces(file, {}); again.connect = reopened.connect;
    assert.equal((await again.call('rotationStatus')).result.state, 'completed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('data access obtains an app-bound grant from a separately authenticated control connection', async () => {
  const { serveSpace } = await import('../runtime/pi-spaces.mjs');
  const key = { alias: 'native', keyId: 'phone-key', algorithm: 'ecdsa-p256', publicKey: 'public', sign: async () => Buffer.from('fixture-signature') };
  const servers = [], calls = [];
  const start = async hostId => {
    const server = await serveSpace({ handleText: async (text, connection) => {
      const call = JSON.parse(text); calls.push([hostId, call.method]);
      const ok = result => JSON.stringify({ ok: true, result });
      if (call.method === 'challenge') return ok({ gateHostId: hostId, observedPeerId: 'phone', connNonce: 'fixture', protocol: 1, issuedAt: Date.now() });
      if (call.method === 'prove') { connection.state = { keyId: call.args.keyId }; return ok({ keyId: call.args.keyId, principal: 'phone', roles: ['member'] }); }
      if (call.method === 'grant') return ok({ grant: { keyId: connection.state?.keyId ?? null } });
      if (call.frame?.grant?.grant?.keyId !== connection.state?.keyId) return JSON.stringify({ ok: false, error: { code: 'PermissionDenied', message: 'grant belongs to another app key' } });
      if (call.method === 'hello') return ok({ spaceId: 'jobs', limits: { maxFrameBytes: 262144 } });
      if (call.method === 'stats') return ok({ entries: 1 });
      if (call.method === 'readAll') return ok({ items: [{ type: 'AcceptanceObject', fields: {} }], next: null });
      throw new Error('unexpected call: ' + call.method);
    } }, { listen: { host: '127.0.0.1', port: 0 } });
    servers.push(server); return `tcp://127.0.0.1:${server.address().port}`;
  };
  const dir = mkdtempSync(join(tmpdir(), 'mobile-grant-'));
  try {
    const client = new MobileSpaces(join(dir, 'profile.json'), { androidSigner: async () => key });
    client.save({ alias: key.alias, keyId: key.keyId, peerId: 'phone', controlHostId: 'control', endpoint: await start('control'), dataHostId: 'data', dataEndpoint: await start('data'), dataSpace: 'jobs', state: 'paired' });
    const reply = await client.call('objects'); assert.equal(reply.result.objects[0].type, 'AcceptanceObject');
    assert.ok(calls.some(([host, method]) => host === 'control' && method === 'prove'));
  } finally { for (const server of servers) await server.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('paired status after rotation proves the current key and rejects a revoked key instead of replaying old enrollment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-paired-status-'));
  try {
    const client = new MobileSpaces(join(dir, 'profile.json'), {});
    client.save({ alias: 'rotated', keyId: 'new-key', peerId: 'phone', state: 'paired', enrollment: { generation: 'old-generation', requestId: 'old-request' } });
    let authenticated = 0, revoked = false;
    client.connect = async () => ({ close() {}, remote: {
      authenticate: async () => { authenticated++; if (revoked) throw new Error('key revoked'); },
      enrollStatus: async () => { throw new Error('old enrollment belongs to old-key'); },
    } });
    assert.deepEqual((await client.call('enrollStatus')).result, { state: 'paired', keyId: 'new-key', peerId: 'phone' });
    assert.equal(authenticated, 1); revoked = true;
    await assert.rejects(client.call('enrollStatus'), /key revoked/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

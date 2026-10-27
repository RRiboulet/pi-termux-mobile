// The session registry's tombstone lifecycle.
//
// Risk covered: a failed or interrupted purge hides sessions by marking them
// `purged`, and a later purge has to be able to find and forget them. If
// `list()` stopped hiding them, they would reappear as openable rows with no
// data; if `purged()` stopped finding them, the retry path would disappear; if
// `forget()` stopped clearing `activeId`, a restart could try to reopen a
// session whose rows are gone. The route's happy path is covered by the e2e
// test; this pins the four methods that only run when something went wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sessionStore } from '../runtime/common.mjs';

/** A sessionStore over an in-memory registry; no harness, no database. */
function storeWith(sessions, activeId = null) {
  const registry = { sessions, activeId };
  const harness = {
    snapshot: async () => registry,
    root: async () => ({
      commit: async (fn) => fn({ doc: async () => registry }),
    }),
  };
  return { store: sessionStore(harness, {}), registry };
}

test('markPurged hides a session, purged() finds it, forget() clears it and activeId', async () => {
  const { store, registry } = storeWith({
    '1': { created: '2026-01-01T00:00:00.000Z' },
    '2': { created: '2026-01-02T00:00:00.000Z', archived: true },
  }, '2');

  assert.deepEqual((await store.list()).map((entry) => entry.id), ['2', '1']);
  assert.ok(await store.get('2'), 'the archived session is not readable');

  await store.markPurged(['2'], { at: '2026-10-27T00:00:00.000Z', reason: 'test' });
  assert.equal(await store.get('2'), undefined, 'a purged session is still readable');
  assert.deepEqual((await store.list()).map((entry) => entry.id), ['1'], 'a purged session is still listed');
  assert.deepEqual((await store.purged()).map((entry) => entry.id), ['2'], 'the tombstone is not recoverable');

  await store.forget(['2']);
  assert.equal(registry.sessions['2'], undefined, 'the tombstone was not removed');
  assert.equal(registry.activeId, null, 'activeId still points at a purged session');
  assert.deepEqual(await store.purged(), [], 'no tombstone should remain');
});

test('a failed forget leaves the tombstone retryable', async () => {
  const { store, registry } = storeWith({ '9': { created: '2026-01-01T00:00:00.000Z' } });
  await store.markPurged(['9']);
  assert.equal(registry.sessions['9'].purged !== undefined, true);
  assert.deepEqual((await store.purged()).map((entry) => entry.id), ['9']);
});

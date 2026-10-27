// The purge SQL: what belongs to a conversation, and what must survive.
//
// Risk covered: this module deletes rows directly, and the store is the only copy
// of the transcripts. The unit test builds a store with pi-durable's own schema,
// gives a conversation a child owned by a conversation and a grandchild owned by
// a task, plus conversation- and task-scoped documents, and then checks that a
// purge removes all of it while leaving the root conversation and the
// session-scoped `app.sessions` document alone. The bridge's route, backup and
// eligibility rules are covered by the e2e test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openHarness } from '../runtime/common.mjs';
import { describePurge, purgeConversations } from '../runtime/purge.mjs';

/** A fresh database with pi-durable's schema, closed so the test can use it. */
async function makeStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-purge-'));
  const dbPath = path.join(dir, 'harness.sqlite');
  const { harness } = await openHarness({ dbPath, models: {}, env: () => ({}), extensions: [] }, {});
  await harness.close({});
  return { dir, dbPath };
}

function seed(dbPath) {
  const db = new DatabaseSync(dbPath);
  const insert = (sql, ...values) => db.prepare(sql).run(...values);
  const conv = (id, ownerConversation = null, ownerTask = null) =>
    insert('INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES (?, ?, ?, ?)',
      id, ownerConversation, ownerTask, '{}');
  const entry = (id, conversation) =>
    insert('INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, NULL, 1, ?)',
      id, conversation, '{}');
  const task = (id, conversation, status) =>
    insert('INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (?, ?, ?, ?, 0, 0, ?)',
      id, conversation, 'generation', status, '{}');
  const submission = (id, conversation, status) =>
    insert('INSERT INTO submissions (id, conversation_id, request_id, status, record) VALUES (?, ?, NULL, ?, ?)',
      id, conversation, status, '{}');
  const doc = (id, scope, owner) =>
    insert(`INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, record)
            VALUES (?, 'test', 0, 'k', ?, ?, 0, '{}')`, id, scope, owner);
  const revision = (document) =>
    insert("INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, 1, 'base', 1, '{}')", document);
  const recordId = (id, type) => insert('INSERT INTO record_ids (id, record_type) VALUES (?, ?)', id, type);

  // 1 is the root; 2 the target; 3 a child owned by 2; 10 a task in 2; 4 a child
  // owned by that task. 5 is an unrelated session.
  conv(1); conv(2); conv(3, 2); conv(4, null, 10); conv(5);
  entry(100, 2); entry(101, 2); entry(102, 3); entry(103, 4); entry(104, 1); entry(105, 5);
  task(10, 2, 'terminal'); task(11, 5, 'running');
  submission(200, 2, 'done'); submission(201, 5, 'done');
  doc(300, 'conversation', 2); doc(301, 'task', 10); doc(302, 'session', 1);
  for (const id of [300, 301, 302]) revision(id);
  for (const [id, type] of [
    [1, 'conversation'], [2, 'conversation'], [3, 'conversation'], [4, 'conversation'], [5, 'conversation'],
    [100, 'entry'], [101, 'entry'], [102, 'entry'], [103, 'entry'], [104, 'entry'], [105, 'entry'],
    [10, 'task'], [11, 'task'], [200, 'submission'], [201, 'submission'],
    [300, 'document'], [301, 'document'], [302, 'document'],
  ]) recordId(id, type);
  db.close();
}

const count = (dbPath, table, where = '', ...params) => {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...params).n; }
  finally { db.close(); }
};

test('a purge takes the conversation, its children and their documents, and leaves the rest', async () => {
  const store = await makeStore();
  try {
    seed(store.dbPath);

    const plan = describePurge(store.dbPath, ['2']);
    assert.deepEqual(plan.byId['2'], {
      conversations: 3, entries: 4, tasks: 1, submissions: 1, documents: 2,
      runningTasks: 0, pendingSubmissions: 0,
    });

    const result = purgeConversations(store.dbPath, ['2']);
    assert.equal(result.vacuumed, true);
    assert.deepEqual(result.totals, { sessions: 1, conversations: 3, entries: 4, tasks: 1, submissions: 1, documents: 2 });

    // The target, its child (owned by the conversation) and its grandchild
    // (owned by the task) are gone; the root and the unrelated session remain.
    assert.equal(count(store.dbPath, 'conversations', 'id IN (2, 3, 4)'), 0);
    assert.equal(count(store.dbPath, 'conversations', 'id IN (1, 5)'), 2);
    assert.equal(count(store.dbPath, 'entries', 'conversation_id IN (2, 3, 4)'), 0);
    assert.equal(count(store.dbPath, 'entries', 'id IN (104, 105)'), 2);
    assert.equal(count(store.dbPath, 'tasks', 'id = 10'), 0);
    assert.equal(count(store.dbPath, 'tasks', 'id = 11'), 1, 'a task in another conversation was deleted');
    assert.equal(count(store.dbPath, 'submissions', 'id = 200'), 0);
    assert.equal(count(store.dbPath, 'submissions', 'id = 201'), 1);

    // Conversation- and task-scoped documents go; the session-scoped registry
    // document does not, because it belongs to the session, not to a conversation.
    assert.equal(count(store.dbPath, 'documents', 'id IN (300, 301)'), 0);
    assert.equal(count(store.dbPath, 'documents', 'id = 302'), 1, 'the session registry was deleted');
    assert.equal(count(store.dbPath, 'document_revisions', 'document_id IN (300, 301)'), 0);
    assert.equal(count(store.dbPath, 'document_revisions', 'document_id = 302'), 1);

    // The id allocator's registry follows the rows it describes.
    assert.equal(count(store.dbPath, 'record_ids', 'id IN (2, 3, 4, 100, 101, 102, 103, 10, 200, 300, 301)'), 0);
    assert.equal(count(store.dbPath, 'record_ids', 'id IN (1, 5, 104, 105, 11, 201, 302)'), 7);
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
});

test('a running task is reported, not deleted', async () => {
  const store = await makeStore();
  try {
    seed(store.dbPath);
    const plan = describePurge(store.dbPath, ['5']);
    assert.equal(plan.byId['5'].runningTasks, 1, 'the running task is not visible to the caller');

    // The module deletes what it is given; the route is what refuses. This pins
    // the signal the route uses.
    assert.equal(plan.byId['5'].pendingSubmissions, 0);
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
});

test('an empty candidate list is a no-op, not a VACUUM', async () => {
  const store = await makeStore();
  try {
    seed(store.dbPath);
    const result = purgeConversations(store.dbPath, []);
    assert.equal(result.vacuumed, false);
    assert.equal(count(store.dbPath, 'conversations'), 5);
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
});

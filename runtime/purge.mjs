// Deleting archived conversations from the durable store.
//
// pi-durable 1.0.3 has no conversation delete: the store is append-only and the
// transcript is the only copy of a session. Archiving hides a session but keeps
// every row, so on a phone the database only grows. When the user asks to purge,
// this module deletes those rows itself, in one SQLite transaction, after the
// bridge has taken a backup (the server does the backup and the eligibility
// checks; this file is only the SQL).
//
// The schema is pi-durable's, not ours: `conversations`, `entries`, `tasks`,
// `submissions`, `documents`/`document_revisions`, and `record_ids`. A purged
// conversation may own child conversations (foreground/background subagents),
// so the target set is closed over `owner_conversation_id` and `owner_task_id`,
// and documents scoped to those conversations or to their tasks go with them.
// Session-scoped documents -- the app's own `app.sessions` registry -- are NOT
// touched: they belong to the session, not to a conversation.
//
// This is deliberately synchronous. It runs on the bridge's event loop while the
// harness holds the same file; a write transaction plus `VACUUM` on a phone-sized
// store is short, and doing it in one transaction is the point. `busy_timeout`
// covers a harness write that is in flight.

import { DatabaseSync } from 'node:sqlite';

const inList = (values) => values.map(() => '?').join(', ');

function open(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * The logical size of the store, in bytes.
 *
 * `stat` on harness.sqlite is not this number in WAL mode: the file can be a
 * single page while every committed page lives in the -wal, and a checkpoint
 * then makes it grow before a purge has removed anything. Page count × page
 * size is the database's own answer and is what a user means by "the store".
 */
function dbBytesOf(db) {
  const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size) || 4096;
  const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count) || 0;
  return pages * pageSize;
}

/**
 * The rows one conversation owns, including its child conversations.
 *
 * Returned as id lists so the caller can union several targets before deleting:
 * two archived sessions cannot normally overlap, but the closure makes that
 * cheap to guarantee rather than assume.
 */
function collect(db, id) {
  const conversations = new Set([Number(id)]);
  for (;;) {
    const known = [...conversations];
    const holes = inList(known);
    const rows = db.prepare(`
      SELECT id FROM conversations
       WHERE owner_conversation_id IN (${holes})
          OR owner_task_id IN (SELECT id FROM tasks WHERE conversation_id IN (${holes}))
    `).all(...known, ...known);
    let grew = false;
    for (const row of rows) {
      const next = Number(row.id);
      if (!conversations.has(next)) { conversations.add(next); grew = true; }
    }
    if (!grew) break;
  }

  const conv = [...conversations];
  const holes = inList(conv);
  const tasks = db.prepare(`SELECT id, status FROM tasks WHERE conversation_id IN (${holes})`).all(...conv);
  const submissions = db.prepare(`SELECT id, status FROM submissions WHERE conversation_id IN (${holes})`).all(...conv);
  const entries = db.prepare(`SELECT id FROM entries WHERE conversation_id IN (${holes})`).all(...conv);

  const taskIds = tasks.map((row) => Number(row.id));
  const docClauses = [`(scope_kind = 'conversation' AND owner_id IN (${holes}))`];
  const docParams = [...conv];
  if (taskIds.length) {
    docClauses.push(`(scope_kind = 'task' AND owner_id IN (${inList(taskIds)}))`);
    docParams.push(...taskIds);
  }
  const documents = db.prepare(`SELECT id FROM documents WHERE ${docClauses.join(' OR ')}`).all(...docParams);

  return {
    conversations: conv,
    entries: entries.map((row) => Number(row.id)),
    tasks: taskIds,
    submissions: submissions.map((row) => Number(row.id)),
    documents: documents.map((row) => Number(row.id)),
    runningTasks: tasks.filter((row) => row.status !== 'terminal').length,
    pendingSubmissions: submissions.filter((row) => row.status === 'queued' || row.status === 'placed').length,
  };
}

/** Union several targets, keeping per-target counts for the report. */
function collectAll(db, ids) {
  const byId = Object.create(null);
  const union = { conversations: new Set(), entries: new Set(), tasks: new Set(), submissions: new Set(), documents: new Set() };
  for (const id of ids) {
    const rows = collect(db, id);
    byId[String(id)] = {
      conversations: rows.conversations.length,
      entries: rows.entries.length,
      tasks: rows.tasks.length,
      submissions: rows.submissions.length,
      documents: rows.documents.length,
      runningTasks: rows.runningTasks,
      pendingSubmissions: rows.pendingSubmissions,
    };
    for (const kind of Object.keys(union)) for (const value of rows[kind]) union[kind].add(value);
  }
  return { byId, union: Object.fromEntries(Object.entries(union).map(([kind, set]) => [kind, [...set]])) };
}

const totalsOf = (byId) => {
  const totals = { sessions: Object.keys(byId).length, conversations: 0, entries: 0, tasks: 0, submissions: 0, documents: 0 };
  for (const row of Object.values(byId)) {
    totals.conversations += row.conversations;
    totals.entries += row.entries;
    totals.tasks += row.tasks;
    totals.submissions += row.submissions;
    totals.documents += row.documents;
  }
  return totals;
};

/**
 * What purging these conversations would remove, without removing it.
 *
 * `runningTasks` and `pendingSubmissions` are the caller's veto: a conversation
 * with work in flight is not a cleanup candidate yet.
 */
export function describePurge(dbPath, ids) {
  const db = open(dbPath);
  try {
    const { byId } = ids.length ? collectAll(db, ids) : { byId: {} };
    return { byId, totals: totalsOf(byId), dbBytes: dbBytesOf(db) };
  } finally {
    db.close();
  }
}

/**
 * Delete the conversations and everything scoped to them.
 *
 * One transaction for every row, then a `VACUUM` (outside the transaction) so
 * the file actually gives the space back. A failed `VACUUM` does not undo the
 * delete and is reported rather than thrown: the rows are gone either way.
 */
export function purgeConversations(dbPath, ids) {
  if (!ids.length) return { byId: {}, totals: { sessions: 0, conversations: 0, entries: 0, tasks: 0, submissions: 0, documents: 0 }, vacuumed: false, beforeBytes: 0, afterBytes: 0 };
  const db = open(dbPath);
  try {
    const beforeBytes = dbBytesOf(db);
    const { byId, union } = collectAll(db, ids);
    const result = { byId, totals: totalsOf(byId), vacuumed: false, beforeBytes, afterBytes: beforeBytes };
    db.exec('BEGIN IMMEDIATE');
    try {
      const del = (table, column, values) => {
        if (values.length) db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${inList(values)})`).run(...values);
      };
      // Revisions first: a document row is the parent, and leaving revisions
      // behind would be dead weight the size check would not explain.
      del('document_revisions', 'document_id', union.documents);
      del('documents', 'id', union.documents);
      del('submissions', 'id', union.submissions);
      del('entries', 'id', union.entries);
      del('tasks', 'id', union.tasks);
      del('conversations', 'id', union.conversations);
      // record_ids is the global id allocator's registry. Leaving the ids of
      // deleted rows behind would make the store grow with garbage that no
      // table references.
      for (const [type, values] of [
        ['conversation', union.conversations],
        ['entry', union.entries],
        ['task', union.tasks],
        ['submission', union.submissions],
        ['document', union.documents],
      ]) {
        if (values.length) db.prepare(`DELETE FROM record_ids WHERE record_type = ? AND id IN (${inList(values)})`).run(type, ...values);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    try {
      db.exec('VACUUM');
      result.vacuumed = true;
    } catch (error) {
      result.vacuumError = error instanceof Error ? error.message : String(error);
    }
    // In WAL mode the vacuumed pages can still sit in the -wal file; truncating
    // it is what makes the freed bytes visible to a size check.
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    result.afterBytes = dbBytesOf(db);
    return result;
  } finally {
    db.close();
  }
}

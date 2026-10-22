// Backpressure on the event stream.
//
// `res.write` queues into the bridge process when a client stops reading, and a
// phone does exactly that: a WebView whose screen went off keeps its socket
// open and stops draining it, so without a bound the bridge buffers the whole
// conversation in memory, silently, until Android kills it.
//
// The rule is a pure function so it can be decided without waiting for a clock
// and tested without one. These tests drive it directly, and then check that
// the server actually calls it -- a rule nothing calls protects nothing.
//
//   node test/sse-backpressure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { applySseBudget, sseBudgetStep, writeSseChunk } from '../runtime/sse.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

const MAX = 1000;
const STALL = 5000;
/** One observation, with the defaults these tests use. */
const at = (bufferedBytes, flushedBytes, now, overSince = null, lastFlushedBytes = null) =>
  sseBudgetStep({
    bufferedBytes, flushedBytes, lastFlushedBytes, overSince, now,
    maxBufferedBytes: MAX, stallMs: STALL,
  });

test('a client that is keeping up is not dropped, and accumulates nothing', () => {
  const r = at(10, 5_000, 1_000);
  assert.equal(r.drop, false);
  assert.equal(r.overSince, null, 'a client under the budget started a stall clock');
});

test('a client that drains between every look is not dropped', () => {
  // This is the trace that falsified the first version of this rule, which
  // compared the depth with the previous look instead of counting what had been
  // drained. A client that reads every frame before the next arrives shows the
  // SAME depth at every look -- it drained to zero and refilled -- so the old
  // rule saw no progress and dropped a client that was reading everything.
  // Measured on that version: dropped at 5s.
  let overSince = null;
  let flushed = 0;
  let now = 0;
  for (let look = 0; look < 10; look++) {
    now += STALL / 2;
    flushed += MAX + 100;                     // it read the whole frame, every time
    const r = at(MAX + 100, flushed, now, overSince, flushed - (MAX + 100));
    assert.equal(r.drop, false, `dropped a fully-draining client at look ${look}`);
    overSince = r.overSince;
  }
});

test('a queue that grows while the client still drains is not dropped', () => {
  // The producer outruns the consumer: depth rises at every look, so depth
  // alone says "no progress", while the cumulative count says the truth.
  let overSince = null;
  let flushed = 0;
  let now = 0;
  for (let look = 0; look < 12; look++) {
    now += 1_000;
    flushed += 200;                           // it is reading 200 units a second
    const r = at(1_000 + 200 * look, flushed, now, overSince, flushed - 200);
    assert.equal(r.drop, false, `dropped a draining client at look ${look}`);
    overSince = r.overSince;
  }
});

test('a client that has not drained at all is dropped after the window', () => {
  const first = at(MAX * 2, 0, 1_000);
  assert.equal(first.drop, false, 'dropped on the first look');
  const later = at(MAX * 2, 0, 1_000 + STALL - 1, first.overSince, 0);
  assert.equal(later.drop, false, 'dropped before the window had elapsed');
  const end = at(MAX * 2, 0, 1_000 + STALL, later.overSince, 0);
  assert.equal(end.drop, true, 'a client that never drained was kept');
});

test('draining under the budget clears the clock', () => {
  // A client that catches up must start from a clean clock next time, or a slow
  // burst would accumulate towards a drop across unrelated stalls.
  const recovered = at(0, 9_999, 2_000, 1_000, 1_000);
  assert.equal(recovered.overSince, null, 'the clock survived the queue draining');
  const again = at(MAX + 1, 9_999, 3_000, recovered.overSince, 9_999);
  assert.equal(again.drop, false);
  assert.equal(again.overSince, 3_000, "the second stall inherited the first one's clock");
});

test('exactly at the budget is not over it', () => {
  assert.equal(at(MAX, 0, 1_000).overSince, null);
  assert.equal(at(MAX + 0.5, 0, 1_000).overSince, 1_000);
});

test('a missing or unusable buffer length never drops a client', () => {
  // `res.writableLength` is undefined on a response that is not a stream yet.
  // Dropping on that would disconnect every client on its first frame.
  for (const bad of [undefined, null, NaN, 'large']) {
    const r = at(bad, undefined, 1_000);
    assert.equal(r.drop, false, `dropped on a buffer length of ${String(bad)}`);
    assert.equal(r.overSince, null);
  }
});

test('the heartbeat samples the queue, so a client that goes quiet is noticed', () => {
  // The one thing the end-to-end test cannot reach without waiting out the
  // window: that the *idle* path samples too. A client that stops reading while
  // nothing is being written is exactly what the heartbeat exists for, and a
  // write-path check would never see it.
  //
  // A textual check is the honest shape here -- importing the server boots it --
  // and it is limited to this, because the write path is proven behaviourally
  // by test/sse-stall-e2e.test.mjs rather than by a regex.
  const server = read('runtime/server.mjs');
  const beatStart = server.indexOf('setInterval(');
  assert.ok(beatStart > 0, 'the bridge has no heartbeat');
  const beat = server.slice(beatStart, server.indexOf('.unref()', beatStart));
  assert.match(beat, /sampleSseBudget\(client\);/, 'the heartbeat never samples the queue');
  assert.match(beat, /SSE_HEARTBEAT_MS/, 'the interval is a literal, so the window cannot reference it');
});

// --- the wiring, with a fake response ----------------------------------------------

test('a healthy client is never dropped, and its clock is cleared', () => {
  const dropped = [];
  const client = { res: { writableLength: 0 }, overSince: 1_000, lastFlushedBytes: 0 };
  for (const now of [2_000, 3_000, 4_000]) {
    const r = applySseBudget(client, { now, maxBufferedBytes: MAX, stallMs: STALL, drop: (c) => dropped.push(c) });
    assert.equal(r.drop, false);
  }
  assert.deepEqual(dropped, [], 'a client that is draining was dropped');
  assert.equal(client.overSince, null, 'the stall clock was left running for a healthy client');
});

test('a client that drains between looks is never dropped, even at a constant depth', () => {
  // The wiring has to compute the cumulative signal from what the bridge has
  // written; if it forgets the count, every look reads as no progress and a
  // client that is reading everything gets dropped. This drives the real entry
  // point with a constant depth and a growing count -- the shape that broke the
  // first version of this rule.
  const dropped = [];
  const client = { res: { writableLength: MAX * 4 }, sseBytesWritten: 0, overSince: null, lastFlushedBytes: null };
  let now = 0;
  for (let look = 0; look < 12; look++) {
    now += STALL;
    client.sseBytesWritten += MAX * 4;        // it read the whole frame between looks
    const r = applySseBudget(client, { now, maxBufferedBytes: MAX, stallMs: STALL, drop: (c) => dropped.push(c) });
    assert.equal(r.drop, false, `dropped a draining client at look ${look}`);
  }
  assert.deepEqual(dropped, []);
});

test('a stalled client is reported to the drop callback with its queue depth', () => {
  const dropped = [];
  const client = { res: { writableLength: MAX * 2 }, sseBytesWritten: MAX * 2, overSince: null, lastFlushedBytes: null };
  const drop = (c, bytes) => dropped.push(bytes);

  // Nothing was drained after the queue filled, so the count stops moving.
  assert.equal(applySseBudget(client, { now: 1_000, maxBufferedBytes: MAX, stallMs: STALL, drop }).drop, false);
  assert.equal(applySseBudget(client, { now: 1_000 + STALL - 1, maxBufferedBytes: MAX, stallMs: STALL, drop }).drop, false);
  assert.equal(applySseBudget(client, { now: 1_000 + STALL, maxBufferedBytes: MAX, stallMs: STALL, drop }).drop, true);
  assert.deepEqual(dropped, [MAX * 2], `the drop did not receive the queue depth: ${JSON.stringify(dropped)}`);
});

test('the clock is per client, not shared between them', () => {
  // The bridge serves several; one slow client must not age another's clock.
  const dropped = [];
  const drop = (c) => dropped.push(c.name);
  const slow = { name: 'slow', res: { writableLength: MAX * 2 }, sseBytesWritten: 0, overSince: null, lastFlushedBytes: null };
  const fresh = { name: 'fresh', res: { writableLength: MAX * 2 }, sseBytesWritten: 0, overSince: null, lastFlushedBytes: null };
  applySseBudget(slow, { now: 1_000, maxBufferedBytes: MAX, stallMs: STALL, drop });
  applySseBudget(fresh, { now: 1_000 + STALL, maxBufferedBytes: MAX, stallMs: STALL, drop });
  assert.deepEqual(dropped, [], 'a client was dropped using another client\'s clock');
  assert.equal(slow.overSince, 1_000);
  assert.equal(fresh.overSince, 1_000 + STALL);
});

// --- the write, and the count it keeps ---------------------------------------------

test('every chunk written is counted, because the drain signal is cumulative', () => {
  // If this count is not kept, the decision function sees "no progress" at every
  // look and drops clients that are reading -- a failure that is invisible from
  // the decision function itself, which is why the write lives here.
  const client = { res: { writableLength: 0, write() {} } };
  assert.equal(client.sseBytesWritten, undefined);
  writeSseChunk(client, 'data: one\n\n', { drop: () => assert.fail('dropped a live client') });
  writeSseChunk(client, 'data: two, longer\n\n', { drop: () => assert.fail('dropped a live client') });
  assert.equal(client.sseBytesWritten, 'data: one\n\n'.length + 'data: two, longer\n\n'.length,
    'the write count is not cumulative, so progress can never be seen');
  // Byte length, not character count: the budget is bytes.
  writeSseChunk(client, 'data: é\n\n', { drop: () => {} });
  const all = 'data: one\n\n' + 'data: two, longer\n\n' + 'data: é\n\n';
  assert.equal(client.sseBytesWritten, Buffer.byteLength(all));
});

test('a write that throws drops the client instead of leaving it in the list', () => {
  const dropped = [];
  const client = {
    sseBytesWritten: 0,
    res: { writableLength: 12, write() { throw new Error('EPIPE'); } },
  };
  const wrote = writeSseChunk(client, 'data: x\n\n', { drop: (c, bytes) => dropped.push(bytes) });
  assert.equal(wrote, false);
  assert.deepEqual(dropped, [12], 'a dead socket was not dropped, so every later write pays for it');
});

test('a closed client is not written to', () => {
  const client = { closed: true, res: { writableLength: 0, write() { assert.fail('wrote to a closed client'); } } };
  assert.equal(writeSseChunk(client, 'data: x\n\n', { drop: () => assert.fail('dropped a closed client') }), false);
});

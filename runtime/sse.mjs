// sse.mjs — how much may be queued for one event-stream client, and when to
// give up on it.
//
// Deliberately imports nothing. The rest of the bridge lives in common.mjs,
// which pulls in pi-durable and the SQLite storage and takes ~9s to import;
// this is arithmetic, and a test of it should not pay for the harness.
//
// The problem this solves: `res.write` queues inside this process when the
// client stops reading, and a suspended WebView does exactly that -- it keeps
// its socket open and stops draining it. Without a bound, the bridge buffers
// the conversation in memory on a phone, and nothing says so.
//
// Not solved with `res.write`'s return value and a 'drain' listener, which is
// the obvious shape: 'drain' fires only when the queue is *empty*, so that rule
// drops a client that is reading slowly but steadily -- the false positive this
// design exists to avoid.

/**
 * One observation of a client's queue: what to remember, and whether to drop.
 *
 * - `bufferedBytes` — what this process still holds for the client
 *   (`res.writableLength`).
 * - `flushedBytes` — a cumulative count of the bytes this process has handed
 *   towards the socket and no longer holds: `written - buffered`. This is the
 *   drain signal, and it has to be cumulative.
 *
 * Depth at a sample instant is not a drain signal. A client that reads every
 * frame between two samples shows *the same* depth at both -- it drained to
 * zero and refilled -- so a rule built on "did the depth go down since last
 * time" drops a client that is reading everything as fast as it is offered.
 * Measured, on the version of this rule that did exactly that: a client that
 * drained each 1.3 MiB frame before the next arrived was dropped at 5s. Growth
 * of the cumulative count is the only thing that means "it read something".
 *
 * A client is dropped when it is over the budget **and** has made no progress
 * for `stallMs`. `stallMs` must be long enough for a real client to be offered
 * and take a frame, or a client can never finish receiving a snapshot larger
 * than the budget: it is dropped mid-transfer, reconnects, and gets the same
 * snapshot again.
 *
 * Nothing here reads a clock or touches a socket, so the decision needs no
 * waiting and its tests need no timers.
 *
 * The caller owns `overSince` and `lastFlushedBytes` and passes them back in.
 *
 * @returns {{drop: boolean, overSince: number|null}} `overSince` is the clock to
 *   carry to the next call; `drop` says whether this observation ends the client.
 */
export function sseBudgetStep({
  bufferedBytes, flushedBytes, lastFlushedBytes = null, overSince = null, now, maxBufferedBytes, stallMs,
}) {
  // `!(a > b)` rather than `a <= b`, so a missing or NaN length is "not over":
  // a response that is not a stream must not disconnect every client at once.
  if (!(bufferedBytes > maxBufferedBytes)) return { drop: false, overSince: null };
  const progressed = typeof lastFlushedBytes === 'number' && typeof flushedBytes === 'number'
    && flushedBytes > lastFlushedBytes;
  const since = progressed || overSince === null ? now : overSince;
  return { drop: now - since >= stallMs, overSince: since };
}

/**
 * Apply the step to a live client, remembering its clocks, and call `drop` when
 * it says so.
 *
 * Apart from the plumbing so the wiring can be tested with a fake response: the
 * bugs this has to avoid are a *shared* clock, where one slow client ages
 * another's, and a forgotten cumulative count, where every look reads as no
 * progress.
 *
 * `client` is `{ res, sseBytesWritten, overSince, lastFlushedBytes }`; `res`
 * only needs `writableLength`.
 */
export function applySseBudget(client, { now, maxBufferedBytes, stallMs, drop }) {
  const bufferedBytes = client.res?.writableLength;
  const flushedBytes = typeof bufferedBytes === 'number'
    ? (client.sseBytesWritten ?? 0) - bufferedBytes
    : undefined;
  const next = sseBudgetStep({
    bufferedBytes, flushedBytes, lastFlushedBytes: client.lastFlushedBytes, overSince: client.overSince,
    now, maxBufferedBytes, stallMs,
  });
  client.overSince = next.overSince;
  client.lastFlushedBytes = typeof flushedBytes === 'number' ? flushedBytes : null;
  if (next.drop) drop(client, bufferedBytes);
  return next;
}

/**
 * Write one chunk to a client, counting it, and call `drop` if the write throws.
 *
 * Here rather than in the server so that the accounting is testable: the drain
 * signal is a cumulative count of what this process has handed over, and a
 * counter that is silently not incremented turns every look into "no progress",
 * which drops clients that are reading. Nothing about that is visible from the
 * decision function, so it is covered by a fake response instead.
 *
 * A write that throws is the strongest evidence a client is gone: dropping it
 * now also stops every later broadcast paying for the same throw.
 *
 * @returns {boolean} whether the chunk was written.
 */
export function writeSseChunk(client, text, { drop }) {
  if (client.closed) return false;
  try {
    client.res.write(text);
  } catch {
    drop(client, client.res?.writableLength ?? 0);
    return false;
  }
  client.sseBytesWritten = (client.sseBytesWritten ?? 0) + Buffer.byteLength(text);
  return true;
}

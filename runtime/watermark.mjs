// Tiny, pure helper for the SSE seq watermark. The kernel (pi-durable) already
// replaces undelivered batches with a snapshot on overflow; this module only
// gives that an explicit, comparable sequence number so a reconnecting client
// can say what it last saw and the bridge can say whether it missed anything.
//
// Kept free of I/O so it can be unit-tested on the host without a database.
export function createWatermark() {
  let seq = 0;
  return {
    /** Current sequence number (0 before anything has been sent). */
    current() { return seq; },
    /** Advance and return the next sequence number. */
    next() { return ++seq; },
    /** Stamp an outbound frame with the next sequence number (mutates in place). */
    stamp(frame) {
      if (frame && typeof frame === 'object') frame.seq = ++seq;
      return frame;
    },
    /** True when `clientSeq` is older than the last sent frame by more than one. */
    gapped(clientSeq) {
      const n = Number(clientSeq);
      if (!Number.isFinite(n) || n < 0) return false;
      // n === 0 means "nothing seen yet" (a fresh client), which is not a gap.
      if (n === 0) return false;
      return n < seq;
    },
  };
}

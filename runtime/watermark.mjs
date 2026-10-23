// A sequence number for the frames the bridge writes, so a client can say which
// frame it last saw and the bridge can say whether anything was written since.
//
// The field is `bridgeSeq`, not `seq`: the kernel already uses `seq` for its own
// commit sequence, and frames here are the kernel's own event objects, so a plain
// `seq` would be two counters sharing one name and silently picking the wrong one.
//
// The counter belongs to the bridge, not to a client: it advances on every frame
// written to anybody. So with more than one client attached, `gapped()` is an
// upper bound -- another client's snapshot moves the counter without this client
// having missed a thing. What it does answer exactly, and all the client uses it
// for, is "were frames written before you attached that you have not seen": the
// attach snapshot that carries the answer is a full state dump, so a true answer
// costs a repaint, not a repair.
//
// Kept free of I/O so it can be unit-tested on the host without a database.
export function createWatermark() {
  let seq = 0;
  return {
    /** Current sequence number (0 before anything has been sent). */
    current() { return seq; },
    /**
     * Stamp an outbound frame with the next sequence number (mutates in place).
     * Stamping is idempotent: a frame written to several clients keeps the number
     * it was given the first time, so they all see the same one for the same frame.
     */
    stamp(frame) {
      if (frame && typeof frame === 'object' && frame.bridgeSeq === undefined) frame.bridgeSeq = ++seq;
      return frame;
    },
    /**
     * True when frames were written after `clientSeq`.
     *
     * `base` is the counter as it stood when the client attached: anything at or
     * below it was written before this connection existed, so a client that has
     * not seen it really did miss it. Frames written later are its own stream
     * arriving, not a gap.
     */
    gapped(clientSeq, base = seq) {
      const n = Number(clientSeq);
      // 0 is "nothing seen yet" (a fresh client), which is not a gap.
      if (!Number.isFinite(n) || n <= 0) return false;
      return n < Number(base);
    },
  };
}

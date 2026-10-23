import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatermark } from '../runtime/watermark.mjs';

test('starts at zero', () => {
  const w = createWatermark();
  assert.equal(w.current(), 0);
});

test('stamp adds seq to frame', () => {
  const w = createWatermark();
  const frame = { type: 'x' };
  const out = w.stamp(frame);
  assert.equal(out, frame);
  assert.equal(frame.bridgeSeq, 1);
  assert.equal(w.current(), 1);
});

test('stamping twice keeps the first number', () => {
  // The same frame goes to every attached client; they must all see one number.
  const w = createWatermark();
  const frame = { type: 'bridge_extensions' };
  w.stamp(frame);
  w.stamp(frame);
  assert.equal(frame.bridgeSeq, 1);
  assert.equal(w.current(), 1);
});

test('gapped false for a fresh client (0)', () => {
  const w = createWatermark();
  w.stamp({}); w.stamp({});
  assert.equal(w.gapped(0, w.current()), false);
  assert.equal(w.gapped(undefined, w.current()), false);
});

test('gapped true when the client missed frames written before it attached', () => {
  const w = createWatermark();
  w.stamp({}); w.stamp({}); w.stamp({}); // seq=3
  assert.equal(w.gapped(1, w.current()), true);
});

test('gapped false when the client is current at the attach point', () => {
  const w = createWatermark();
  w.stamp({}); w.stamp({}); // seq=2
  assert.equal(w.gapped(2, w.current()), false);
  assert.equal(w.gapped(1, w.current()), true);
});

test('gapped false for frames written after the client attached', () => {
  // The attach snapshot is stamped after the base is taken; it is this client's
  // own stream arriving, not something it missed.
  const w = createWatermark();
  w.stamp({}); // seq=1, the client has seen it
  const base = w.current();
  w.stamp({ type: 'bridge_snapshot' }); // seq=2, written to this client
  assert.equal(w.gapped(1, base), false);
});

test('gapped false for invalid input', () => {
  const w = createWatermark();
  w.stamp({});
  assert.equal(w.gapped('abc', 1), false);
  assert.equal(w.gapped(null, 1), false);
  assert.equal(w.gapped(-1, 1), false);
});

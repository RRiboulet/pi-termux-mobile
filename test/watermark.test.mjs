import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatermark } from '../runtime/watermark.mjs';

test('starts at zero', () => {
  const w = createWatermark();
  assert.equal(w.current(), 0);
});

test('next increments and returns', () => {
  const w = createWatermark();
  assert.equal(w.next(), 1);
  assert.equal(w.next(), 2);
  assert.equal(w.current(), 2);
});

test('stamp adds seq to frame', () => {
  const w = createWatermark();
  const frame = { type: 'x' };
  const out = w.stamp(frame);
  assert.equal(out, frame);
  assert.equal(frame.seq, 1);
  assert.equal(w.current(), 1);
});

test('gapped false for fresh client (0)', () => {
  const w = createWatermark();
  w.next(); w.next();
  assert.equal(w.gapped(0), false);
});

test('gapped true when client missed a frame', () => {
  const w = createWatermark();
  w.next(); w.next(); w.next(); // seq=3
  assert.equal(w.gapped(1), true);
});

test('gapped false when client is current', () => {
  const w = createWatermark();
  w.next(); w.next(); // seq=2
  assert.equal(w.gapped(2), false);
  assert.equal(w.gapped(1), true);
});

test('gapped false for invalid input', () => {
  const w = createWatermark();
  w.next();
  assert.equal(w.gapped('abc'), false);
  assert.equal(w.gapped(null), false);
  assert.equal(w.gapped(-1), false);
});

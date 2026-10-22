// node-bin.mjs: the node binary to spawn, on a phone and on a host.
//
// On Android, process.execPath is the dynamic linker when node was started
// through it, and the linker cannot run a JavaScript file. These tests pin
// the one thing that has to be true: the module never hands back the linker.
//
//   node test/node-bin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isLinker, nodeBinary, nodeBinaryOrNode, onPath } from '../runtime/node-bin.mjs';

/** A directory with files in it, so "exists" can be told from "does not". */
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'node-bin-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const make = (name, content = '#!/bin/sh\n') => {
    const p = path.join(bin, name);
    writeFileSync(p, content);
    chmodSync(p, 0o755);
    return p;
  };
  return { dir, bin, make, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the linker is not a program to spawn', () => {
  assert.equal(isLinker('/system/bin/linker64'), true);
  assert.equal(isLinker('/apex/com.android.runtime/bin/linker64'), true);
  assert.equal(isLinker('/data/data/app.pidabl/files/usr/bin/node'), false);
  assert.equal(isLinker(''), false);
  assert.equal(isLinker(null), false);
});

test('argv0 wins over execPath, because argv0 is the program that was asked to run', () => {
  const { bin, make, cleanup } = sandbox();
  try {
    const node = make('node');
    const linker = make('linker64');
    // What Android looks like: argv0 is node, execPath is the linker.
    const found = nodeBinary({ PATH: bin }, node, linker);
    assert.equal(found, node);
  } finally {
    cleanup();
  }
});

test('the linker is refused even when it is the only thing on offer', () => {
  const { bin, make, cleanup } = sandbox();
  try {
    const linker = make('linker64');
    // No node anywhere: the answer is "none", not the linker.
    assert.equal(nodeBinary({ PATH: bin }, linker, linker), null);
  } finally {
    cleanup();
  }
});

test('execPath is used when argv0 is no use', () => {
  const { bin, make, cleanup } = sandbox();
  try {
    const node = make('node');
    const found = nodeBinary({ PATH: bin }, '', node);
    assert.equal(found, node);
  } finally {
    cleanup();
  }
});

test('a bare name is looked up on PATH', () => {
  const { bin, make, cleanup } = sandbox();
  try {
    const node = make('node');
    // "node" is what a shell passes when it finds node on PATH.
    assert.equal(nodeBinary({ PATH: bin }, 'node', '/system/bin/linker64'), node);
  } finally {
    cleanup();
  }
});

test('node on PATH is the last resort', () => {
  const { bin, make, cleanup } = sandbox();
  try {
    const node = make('node');
    assert.equal(nodeBinary({ PATH: bin }, '', ''), node);
  } finally {
    cleanup();
  }
});

test('a program that is not node is not offered as node', () => {
  const { bin, make, cleanup } = sandbox();
  try {
    make('bash');
    assert.equal(nodeBinary({ PATH: bin }, path.join(bin, 'bash'), path.join(bin, 'bash')), null);
  } finally {
    cleanup();
  }
});

test('PATH lookup finds a program the way a shell does', () => {
  const { bin, make, cleanup } = sandbox();
  try {
    const node = make('node');
    assert.equal(onPath('node', { PATH: bin }), node);
    assert.equal(onPath('node', { PATH: '/nowhere' }), null);
    assert.equal(onPath('node', { PATH: '' }), null);
  } finally {
    cleanup();
  }
});

test('the fallback is always something a shell can run', () => {
  assert.equal(nodeBinaryOrNode({ PATH: '/nowhere' }, '', ''), 'node');
});

test('in this process the answer is a real node, never the linker', () => {
  // On a phone this process may well have been started through the linker,
  // and process.execPath is then the linker. The module must not hand that
  // back, whatever this process looks like.
  const found = nodeBinaryOrNode();
  assert.ok(found, 'no node binary was found');
  assert.equal(isLinker(found), false, `the linker was handed back: ${found}`);
});

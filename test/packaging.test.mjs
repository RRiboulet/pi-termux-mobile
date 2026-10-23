// The APK ships an explicit list of runtime files, and the list is the only
// thing that decides what is inside `runtime.bin`.
//
// A module that `server.mjs` imports but the list does not name boots perfectly
// from the repo -- every test in this directory runs against the tree -- and
// dies on the phone at startup with
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../runtime/x.mjs'
//
// which is a bridge that never listens and a UI with nothing to show. So the
// list is checked against the tree here, rather than remembered in a review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, 'runtime');
const SCRIPT = readFileSync(path.join(ROOT, 'scripts', 'prepare-runtime.py'), 'utf8');

/** The FILES list, read out of the packaging script itself. */
function packaged() {
  const list = SCRIPT.match(/^FILES = \[([\s\S]*?)\]/m);
  assert.ok(list, 'scripts/prepare-runtime.py no longer has a FILES list');
  return [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('every runtime module is packaged', () => {
  const files = packaged();
  const modules = readdirSync(RUNTIME).filter((name) => name.endsWith('.mjs'));
  assert.ok(modules.length >= 5, `only found ${modules.length} runtime modules; is runtime/ the right directory?`);
  for (const name of modules) {
    assert.ok(files.includes(name), `${name} is in runtime/ but not in FILES in scripts/prepare-runtime.py, so it would be missing from the APK`);
  }
});

test('everything packaged is in the tree', () => {
  for (const name of packaged()) {
    assert.ok(existsSync(path.join(RUNTIME, name)), `scripts/prepare-runtime.py packages ${name}, which is not in runtime/`);
  }
});

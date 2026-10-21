// The client and the server agree on a set of paths, and nothing in the test
// suite checks that: the client tests mock `fetch`, and the server tests
// exercise the server alone. So a route removed on one side and still called
// on the other is invisible to both — and it fails on the phone, where the
// request 404s and the screen simply does not update.
//
// This reads both files and compares them. It is a textual check on purpose:
// importing the server would start it, bind a port and open a database, which
// is not something a unit test should do.
//
//   node test/client-server-contract.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

/** Every /api/... path literal in a source file. */
function apiPaths(source) {
  return new Set(source.match(/\/api\/[a-z0-9/-]+/g) ?? []);
}

const clientPaths = apiPaths(read('runtime/public/app.js'));
const serverPaths = apiPaths(read('runtime/server.mjs'));

test('every path the client calls is one the server serves', () => {
  const missing = [...clientPaths].filter((p) => !serverPaths.has(p)).sort();
  assert.deepEqual(missing, [], `the client calls paths the server does not serve: ${missing.join(', ')}`);
});

test('the client calls paths at all', () => {
  // A regex that stopped matching would make the test above pass vacuously.
  assert.ok(clientPaths.size >= 15, `only ${clientPaths.size} client paths were found`);
  assert.ok(serverPaths.size >= 15, `only ${serverPaths.size} server paths were found`);
});

test('the server serves nothing the client cannot reach', () => {
  // A path the server still serves but no client calls is dead surface: it is
  // a route to keep working, document and test for no reason.
  // "/api/oauth" is the server's prefix check, not a route, so it is ignored.
  const unreachable = [...serverPaths]
    .filter((p) => !clientPaths.has(p))
    .filter((p) => !serverPaths.has(`${p}/`))
    .filter((p) => p !== '/api/oauth')
    .sort();
  assert.deepEqual(unreachable, [], `the server serves paths no client calls: ${unreachable.join(', ')}`);
});

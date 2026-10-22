// run-tests.mjs — run the test files, on a phone and on a host.
//
// Node's own runner (`node --test`) spawns one child process per test file,
// using process.execPath to do it. On Android process.execPath is the
// dynamic linker, not node, so the child is the linker and the run dies
// before the first test:
//
//   error: expected absolute path: "--test-concurrency=0"
//
// That message is the linker complaining about the flag it was handed.
//
// So this runner does the spawning itself, with the node binary resolved the
// way runtime/node-bin.mjs resolves it: process.argv0, which is the program
// that was asked to run in every launch mode.
//
// Each test file runs on its own, the way `node --test` runs it, so a file
// that leaves the process in a strange state cannot affect the next one. A
// file that fails exits non-zero on its own, so the exit code of the run is
// the exit code of the worst file.
//
//   node scripts/run-tests.mjs              # every test/*.test.mjs
//   node scripts/run-tests.mjs client gh    # only the files whose name matches

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeBinaryOrNode } from '../runtime/node-bin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

/** The test files, in a stable order. */
export function testFiles(dir = TEST_DIR) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Run one test file. Resolves to its exit code. */
function runFile(bin, file) {
  return new Promise((resolve) => {
    const child = spawn(bin, [file], { stdio: 'inherit', cwd: ROOT });
    child.on('error', (e) => {
      process.stderr.write(`cannot run ${path.basename(file)}: ${e.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Run the test files whose names match every filter. */
export async function runTests(filters = []) {
  const bin = nodeBinaryOrNode();
  const files = testFiles().filter((file) => {
    if (!filters.length) return true;
    const name = path.basename(file);
    return filters.every((f) => name.includes(f));
  });
  if (!files.length) {
    process.stderr.write('no test files matched\n');
    return 1;
  }
  const failed = [];
  for (const file of files) {
    process.stdout.write(`\n── ${path.basename(file)} ${'─'.repeat(Math.max(0, 60 - path.basename(file).length))}\n`);
    const code = await runFile(bin, file);
    if (code !== 0) failed.push(path.basename(file));
  }
  process.stdout.write(`\n${files.length - failed.length}/${files.length} test files passed\n`);
  if (failed.length) {
    process.stdout.write(`failed: ${failed.join(', ')}\n`);
    return 1;
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = await runTests(process.argv.slice(2));
}

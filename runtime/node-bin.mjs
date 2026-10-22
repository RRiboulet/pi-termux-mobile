// node-bin.mjs — the node binary to spawn, on a phone and on a host.
//
// On a host, process.execPath is the node binary and everything is fine. On
// Android it is not:
//
//   * termux-exec re-execs every process through the system dynamic linker,
//     so /proc/self/exe is the linker and Node reports that as
//     process.execPath. Any Termux shell sees this — including the shell the
//     agent works in.
//   * PiService has the same fallback for the app-home exec ban: when the
//     direct exec of <prefix>/bin/node fails, it runs
//     "/system/bin/linker64 <prefix>/bin/node server.mjs".
//
// Spawning process.execPath in either case runs the *linker*, and the linker
// cannot run a JavaScript file:
//
//   error: "/data/data/app.pidabl/files/usr/bin/node_modules/npm/bin/npm-cli.js"
//   has bad ELF magic: 23212f64
//
// process.argv0 is the program that was asked to run: termux-exec rewrites
// argv[0] to it, and ProcessBuilder passes the full path. It is the node
// binary in every launch mode, so that is what this module returns.
//
// Node's own test runner has the same problem and cannot be fixed from here:
// it spawns its per-file child processes with process.execPath, so
// `node --test` dies with
//
//   error: expected absolute path: "--test-concurrency=0"
//
// (that message is the linker complaining about the flag it was handed).
// scripts/run-tests.mjs runs the test files itself instead.

import { statSync } from 'node:fs';
import path from 'node:path';

/** The Android dynamic linkers. They load an ELF; they are not node. */
const LINKERS = new Set(['linker64', 'linker', 'ld-android', 'ld-android-aarch64']);

/** Is this path the dynamic linker rather than a program? */
export function isLinker(candidate) {
  if (!candidate) return false;
  return LINKERS.has(path.basename(candidate));
}

/** Is this a regular file? A symlink to one counts: stat follows them. */
function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Does this look like the node binary, and not some other program? */
function looksLikeNode(candidate) {
  const base = path.basename(candidate);
  return base === 'node' || base.startsWith('node-') || base.startsWith('node.');
}

/** Find a program on PATH, the way a shell would. */
export function onPath(name, env = process.env) {
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The node binary to spawn.
 *
 * Returns an absolute path, or null when there is none to be found.
 */
export function nodeBinary(env = process.env, argv0 = process.argv0, execPath = process.execPath) {
  const candidates = [];

  // 1. argv0: the program that was asked to run. Right on a phone, right on
  //    a host. A bare name ("node") means it was found on PATH.
  if (argv0) {
    candidates.push(argv0.includes(path.sep) ? argv0 : onPath(argv0, env));
  }
  // 2. execPath: right on a host, the linker on Android.
  candidates.push(execPath);
  // 3. node on PATH: the last resort.
  candidates.push(onPath('node', env));

  for (const candidate of candidates) {
    if (!candidate || isLinker(candidate)) continue;
    if (!isFile(candidate)) continue;
    if (!looksLikeNode(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * The node binary to spawn, with a fallback that is always usable.
 *
 * The fallback is the plain name "node", so that a shell finds it on PATH
 * rather than the caller being handed nothing at all.
 */
export function nodeBinaryOrNode(env = process.env, argv0 = process.argv0, execPath = process.execPath) {
  return nodeBinary(env, argv0, execPath) || 'node';
}

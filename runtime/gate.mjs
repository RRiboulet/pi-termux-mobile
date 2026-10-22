// gate.mjs — the install gate.
//
// The agent can write code. Code it writes *for the kernel* is not sandboxed
// code: an extension runs inside this process, with this process's uid and
// its secrets. The plan (§2.8) is explicit about it:
//
//   "Agent-written extensions are user-confirmed installs. The agent writes
//    workspace/extensions/foo.ts; the kernel shows the file, hash and diff;
//    the user taps Install; then registry.install()."
//   "An agent-written extension is kernel code, not sandboxed code."
//
// So the gate is an accident guardrail, not a boundary. It makes the user
// look at the code before it runs, and it makes the kernel's own behaviour
// change an explicit, recorded act. It does not contain a malicious agent:
// the same agent can read the token and call the bridge itself. The plan says
// so, and this file says so, so that nobody mistakes the gate for a wall.
//
// What the gate does:
//
//   * finds the extensions the agent wrote in the workspace's extensions/ dir
//   * hashes them, and diffs them against the version that was installed
//   * installs one — but only the exact hash the user was shown
//   * remembers the rejections, so the same code cannot be proposed in a loop
//   * re-installs what was installed, so a bridge restart keeps the kernel's
//     own extensions
//
// The hot install works because pi-durable reads the registry when it
// resolves an agent, not when the harness opens: a newly installed extension
// is in the next turn's tool list, with no restart and no lost session.

import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync,
  symlinkSync, writeFileSync, renameSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The file names a proposal may have. A `.js` file is CommonJS unless a
 *  package.json above it says otherwise, so `.mjs` is the one to write. */
export const PROPOSAL_SUFFIXES = ['.mjs', '.js'];

/** A proposal bigger than this is not a proposal; it is a mistake. */
export const MAX_PROPOSAL_BYTES = 256 * 1024;

/** Extension names, tool names and section keys: lowercase, then letters,
 *  digits, dash and underscore. The same rule the registry uses for sections. */
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** Lines of context around a change in a diff. */
const CONTEXT = 3;

/** The diff is a quadratic table; past this many lines on a side it is
 *  refused rather than quietly eating the phone's memory. */
const MAX_DIFF_LINES = 1500;

/** An error with a status code, so the server can answer with it. */
export class GateError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The sha256 of a string, hex. The hash is what the user approves. */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The short form of a hash, for a screen. */
export function shortHash(hash) {
  return typeof hash === 'string' && hash.length >= 12 ? hash.slice(0, 12) : String(hash ?? '');
}

/**
 * A unified diff between two texts, line by line.
 *
 * The longest common subsequence decides what is a change and what is
 * context; the output is the usual `@@ -a,b +c,d @@` hunks. An empty `before`
 * is a new file, so every line is an addition.
 */
export function diffLines(before, after) {
  const left = splitLines(before);
  const right = splitLines(after);
  const a = left.lines;
  const b = right.lines;
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return `--- (too large to diff: ${a.length} and ${b.length} lines)\n`;
  }
  const m = a.length;
  const n = b.length;
  // dp[i][j] is the length of the LCS of a[i..] and b[j..].
  const width = n + 1;
  const dp = new Int32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i], lastA: i === m - 1, lastB: j === n - 1 });
      i++; j++; continue;
    }
    if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ type: '-', text: a[i], lastA: i === m - 1, lastB: false });
      i++;
    } else {
      ops.push({ type: '+', text: b[j], lastA: false, lastB: j === n - 1 });
      j++;
    }
  }
  while (i < m) { ops.push({ type: '-', text: a[i], lastA: i === m - 1, lastB: false }); i++; }
  while (j < n) { ops.push({ type: '+', text: b[j], lastA: false, lastB: j === n - 1 }); j++; }
  if (!ops.some((op) => op.type !== ' ')) return '';

  // Group the changes into hunks, each with CONTEXT lines around it.
  const changed = ops.map((op) => op.type !== ' ');
  const hunks = [];
  let start = -1;
  for (let k = 0; k < ops.length; k++) {
    if (changed[k] && start < 0) start = k;
    if ((!changed[k] || k === ops.length - 1) && start >= 0) {
      const last = changed[k] ? k : k - 1;
      hunks.push([Math.max(0, start - CONTEXT), Math.min(ops.length - 1, last + CONTEXT)]);
      start = -1;
    }
  }
  // The line numbers of each side, as the hunks walk the operations.
  const lineOf = [0, 0]; // [a, b]
  const beforeStart = [];
  const afterStart = [];
  for (const op of ops) {
    beforeStart.push(lineOf[0]);
    afterStart.push(lineOf[1]);
    if (op.type !== '+') lineOf[0]++;
    if (op.type !== '-') lineOf[1]++;
  }
  const out = [];
  for (const [from, to] of hunks) {
    let aStart = beforeStart[from];
    let bStart = afterStart[from];
    let aCount = 0;
    let bCount = 0;
    for (let k = from; k <= to; k++) {
      if (ops[k].type !== '+') aCount++;
      if (ops[k].type !== '-') bCount++;
    }
    out.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    for (let k = from; k <= to; k++) {
      out.push(`${ops[k].type}${ops[k].text}`);
      // A file whose last line has no newline says so, as diff does.
      if (ops[k].lastA && !left.endsWithNewline) out.push('\\ No newline at end of file');
      if (ops[k].lastB && !right.endsWithNewline) out.push('\\ No newline at end of file');
    }
  }
  return out.join('\n');
}

/**
 * The lines of a text, and whether its last line is newline-terminated.
 *
 * A trailing newline terminates the last line; it does not add an empty one.
 */
function splitLines(text) {
  const t = String(text ?? '');
  if (t === '') return { lines: [], endsWithNewline: true };
  const lines = t.split('\n');
  if (lines[lines.length - 1] === '') { lines.pop(); return { lines, endsWithNewline: true }; }
  return { lines, endsWithNewline: false };
}

/**
 * Check a module for the shape of an extension, and build the extension the
 * registry can take.
 *
 * The rules are deliberately narrow, because the code is kernel code:
 *
 *   * a name, lowercase
 *   * tools: a name, a description, a JSON schema for the parameters, a
 *     function to run
 *   * sections: a key and a render function
 *
 * `tasks` and `wraps` are refused. A task is scheduled by the kernel and a
 * wrap intercepts other tools: both are a much larger surface than a tool,
 * and v1 does not need them.
 *
 * Every tool is installed with `replay: 'unsafe'`. That is pi-durable's own
 * default, and it is the right one here: a replayed tool runs again after a
 * crash, and nobody can show that agent-written code is safe to run twice.
 */
export function validateExtension(mod) {
  const problems = [];
  const candidate = unwrap(mod);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { extension: null, problems: ['the file does not export an extension object'] };
  }
  const name = candidate.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    problems.push('the extension needs a name: lowercase letters, then letters, digits, - or _');
  }
  if (candidate.tasks !== undefined) problems.push('tasks are not accepted in v1');
  if (candidate.wraps !== undefined) problems.push('wraps are not accepted in v1');

  const tools = [];
  if (candidate.tools !== undefined) {
    if (!Array.isArray(candidate.tools)) {
      problems.push('tools must be an array');
    } else {
      candidate.tools.forEach((tool, index) => {
        if (!tool || typeof tool !== 'object') {
          problems.push(`tool ${index} is not an object`);
          return;
        }
        if (typeof tool.name !== 'string' || !NAME_RE.test(tool.name)) {
          problems.push(`tool ${index} needs a name: lowercase letters, then letters, digits, - or _`);
        }
        if (typeof tool.description !== 'string' || !tool.description.trim()) {
          problems.push(`tool ${tool.name ?? index} needs a description`);
        }
        if (!tool.parameters || typeof tool.parameters !== 'object') {
          problems.push(`tool ${tool.name ?? index} needs parameters (a JSON schema)`);
        }
        if (typeof tool.execute !== 'function') {
          problems.push(`tool ${tool.name ?? index} needs an execute function`);
        }
        tools.push({ ...tool, replay: 'unsafe' });
      });
    }
  }

  const sections = [];
  if (candidate.sections !== undefined) {
    if (!Array.isArray(candidate.sections)) {
      problems.push('sections must be an array');
    } else {
      candidate.sections.forEach((sec, index) => {
        if (!sec || typeof sec !== 'object') {
          problems.push(`section ${index} is not an object`);
          return;
        }
        if (typeof sec.key !== 'string' || !NAME_RE.test(sec.key)) {
          problems.push(`section ${index} needs a key: lowercase letters, then letters, digits, - or _`);
        }
        if (typeof sec.render !== 'function') {
          problems.push(`section ${sec.key ?? index} needs a render function`);
        }
        sections.push(sec);
      });
    }
  }

  if (problems.length) return { extension: null, problems };
  return { extension: { name, tools, sections }, problems };
}

/** A module's extension is its default export, or the export named `extension`. */
function unwrap(mod) {
  if (!mod || typeof mod !== 'object') return mod;
  if (mod.extension && typeof mod.extension === 'object') return mod.extension;
  if (mod.default && typeof mod.default === 'object') return mod.default;
  return mod;
}

/**
 * The install gate.
 *
 * The proposals live in one directory: the agent's workspace, in `extensions/`.
 * That is the plan's `workspace/extensions/`, and it is the agent's own
 * directory: the file the agent writes is the file the user is shown.
 */
export class InstallGate {
  #dir;
  #stateFile;
  #registry;
  #now;
  #onChange;
  #state = null;

  constructor({ dir, stateFile, registry, now = () => Date.now(), onChange = () => {} }) {
    if (!dir) throw new Error('the gate needs a directory');
    this.#dir = path.resolve(dir);
    this.#stateFile = stateFile;
    this.#registry = registry ?? null;
    this.#now = now;
    this.#onChange = onChange;
  }

  /** The directory the proposals live in. */
  get dir() { return this.#dir; }

  /** The state, read once and kept. */
  get state() {
    if (this.#state) return this.#state;
    let parsed = null;
    try { parsed = JSON.parse(readFileSync(this.#stateFile, 'utf8')); } catch { parsed = null; }
    this.#state = {
      version: 1,
      installed: parsed?.installed && typeof parsed.installed === 'object' ? parsed.installed : {},
      rejected: parsed?.rejected && typeof parsed.rejected === 'object' ? parsed.rejected : {},
      proposed: parsed?.proposed && typeof parsed.proposed === 'object' ? parsed.proposed : {},
    };
    return this.#state;
  }

  #save() {
    if (!this.#stateFile) return;
    mkdirSync(path.dirname(this.#stateFile), { recursive: true });
    const tmp = `${this.#stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#stateFile);
  }

  /** The path a key names, refusing anything outside the proposals dir. */
  resolve(key) {
    const name = String(key ?? '');
    if (!name) throw new GateError(400, 'no file named');
    const file = path.resolve(this.#dir, name);
    if (file !== this.#dir && !file.startsWith(this.#dir + path.sep)) {
      throw new GateError(400, 'the path is outside the extensions directory');
    }
    return file;
  }

  /** The key of a file, relative to the proposals dir. */
  keyOf(file) {
    return path.relative(this.#dir, file).split(path.sep).join('/');
  }

  /** The proposal files: everything in the dir that could be an extension. */
  files() {
    let entries = [];
    try { entries = readdirSync(this.#dir, { withFileTypes: true }); } catch { return []; }
    return entries
      .filter((e) => e.isFile() && PROPOSAL_SUFFIXES.includes(path.extname(e.name)))
      .map((e) => path.join(this.#dir, e.name))
      .sort();
  }

  /** What is in a file right now: its text, its hash, and its size. */
  read(file) {
    const stat = statSync(file);
    if (!stat.isFile()) throw new GateError(400, 'not a file');
    if (stat.size > MAX_PROPOSAL_BYTES) {
      throw new GateError(400, `the file is ${stat.size} bytes; a proposal may be at most ${MAX_PROPOSAL_BYTES}`);
    }
    const text = readFileSync(file, 'utf8');
    return { text, hash: sha256(text), bytes: stat.size };
  }

  /**
   * The state of one proposal: pending, installed, rejected, or changed
   * since it was approved.
   */
  statusOf(file) {
    const key = this.keyOf(file);
    const current = this.read(file);
    return this.#status(key, current);
  }

  /** The state of a proposal, from what was just read. */
  #status(key, current) {
    const installed = this.state.installed[key];
    if (installed && installed.hash === current.hash) {
      return { key, hash: current.hash, bytes: current.bytes, state: 'installed', installed };
    }
    if (this.state.rejected[key] === current.hash) {
      return { key, hash: current.hash, bytes: current.bytes, state: 'rejected' };
    }
    if (installed) return { key, hash: current.hash, bytes: current.bytes, state: 'changed', installed };
    return { key, hash: current.hash, bytes: current.bytes, state: 'pending' };
  }

  /**
   * Every proposal, with the diff the user is shown: the proposed file
   * against the version that was installed.
   */
  proposals() {
    const out = [];
    for (const file of this.files()) {
      let current;
      try { current = this.read(file); } catch { continue; }
      const key = this.keyOf(file);
      const installed = this.state.installed[key];
      const status = this.#status(key, current);
      out.push({
        key,
        hash: status.hash,
        bytes: status.bytes,
        state: status.state,
        name: installed?.name ?? null,
        proposedAt: this.state.proposed[key]?.at ?? null,
        diff: diffLines(installed?.content ?? '', current.text),
      });
    }
    return out;
  }

  /** The extensions that are installed, by key. */
  installed() {
    return Object.entries(this.state.installed).map(([key, rec]) => ({
      key,
      name: rec.name ?? null,
      hash: rec.hash,
      installedAt: rec.installedAt ?? null,
    }));
  }

  /**
   * Record that the agent wants this file installed, and say where it
   * stands. This is what the agent's tool calls.
   */
  propose(key) {
    const file = this.resolve(key);
    if (!existsSync(file)) throw new GateError(404, `no such file: ${key}`);
    const status = this.statusOf(file);
    if (status.state === 'installed') {
      return { ...status, message: `${status.key} is installed (${shortHash(status.hash)}).` };
    }
    if (status.state === 'rejected') {
      return { ...status, message: `${status.key} was rejected by the user (${shortHash(status.hash)}). Change the file before proposing it again.` };
    }
    if (status.state === 'changed') {
      return { ...status, message: `${status.key} changed since it was installed. The user has to approve the new version.` };
    }
    this.state.proposed[status.key] = { hash: status.hash, at: this.#now() };
    this.#save();
    this.#onChange();
    return {
      ...status,
      message: `${status.key} is proposed (sha256 ${shortHash(status.hash)}). The user has to approve it in the Extensions sheet before it runs.`,
    };
  }

  /**
   * Install a proposal: import it, check it, and put it in the registry.
   *
   * `expectedHash` is the hash the user was shown, and it is required: the
   * user approved a file, not a name. If the file changed since, the install
   * is refused.
   */
  async install(key, expectedHash) {
    if (!expectedHash) throw new GateError(400, 'the hash is required: approve the file you were shown');
    const file = this.resolve(key);
    if (!existsSync(file)) throw new GateError(404, `no such file: ${key}`);
    const { text, hash } = this.read(file);
    if (expectedHash !== hash) {
      throw new GateError(409, 'the file changed since you approved it; look at it again');
    }
    const mod = await this.#import(file, hash);
    const { extension, problems } = validateExtension(mod);
    if (problems.length) {
      throw new GateError(400, problems.join('; '));
    }
    if (!this.#registry) throw new GateError(500, 'the gate has no registry to install into');
    this.#registry.install(extension);
    const previous = this.state.installed[key];
    // One extension, one name: if another file provided the same name, it is
    // the one that was replaced, and the state says so.
    for (const [other, record] of Object.entries(this.state.installed)) {
      if (other !== key && record.name === extension.name) delete this.state.installed[other];
    }
    this.state.installed[key] = {
      file: this.keyOf(file),
      hash,
      name: extension.name,
      installedAt: this.#now(),
      content: text,
      replaced: previous?.name ?? null,
    };
    delete this.state.rejected[key];
    this.#save();
    this.#onChange();
    return { key, name: extension.name, hash, tools: extension.tools.map((t) => t.name) };
  }

  /** Refuse a proposal, and remember that this version was refused. */
  reject(key, hash) {
    const file = this.resolve(key);
    if (!existsSync(file)) throw new GateError(404, `no such file: ${key}`);
    const current = this.read(file).hash;
    if (hash && hash !== current) {
      throw new GateError(409, 'the file changed since you looked at it');
    }
    this.state.rejected[key] = current;
    this.#save();
    this.#onChange();
    return { key, hash: current };
  }

  /** Take an installed extension back out of the registry. */
  uninstall(key) {
    const record = this.state.installed[key];
    if (!record) throw new GateError(404, `nothing is installed as ${key}`);
    const extension = this.#registry?.snapshot().extension(record.name);
    if (extension && this.#registry) this.#registry.uninstall(extension);
    delete this.state.installed[key];
    this.#save();
    this.#onChange();
    return { key, name: record.name };
  }

  /**
   * Install what was installed, after a restart.
   *
   * A file that changed since it was approved is *not* installed: the user
   * approved a hash, and the file is not that hash any more. It shows up as a
   * proposal again, which is the honest reading.
   */
  async restore() {
    const results = [];
    for (const [key, record] of Object.entries(this.state.installed)) {
      const file = path.resolve(this.#dir, key);
      if (!existsSync(file)) {
        results.push({ key, name: record.name, ok: false, error: 'the file is gone' });
        continue;
      }
      let current;
      try { current = this.read(file); } catch (error) {
        results.push({ key, name: record.name, ok: false, error: String(error.message ?? error) });
        continue;
      }
      if (current.hash !== record.hash) {
        results.push({ key, name: record.name, ok: false, error: 'the file changed since it was approved' });
        continue;
      }
      try {
        const mod = await this.#import(file, current.hash);
        const { extension, problems } = validateExtension(mod);
        if (problems.length) throw new Error(problems.join('; '));
        this.#registry?.install(extension);
        results.push({ key, name: extension.name, ok: true });
      } catch (error) {
        results.push({ key, name: record.name, ok: false, error: String(error?.message ?? error) });
      }
    }
    return results;
  }

  /**
   * Import the file, with a query on the URL so a changed file is a new
   * module and not the cached one.
   */
  async #import(file, hash) {
    const url = `${pathToFileURL(file).href}?v=${hash}`;
    return import(url);
  }
}

/**
 * Make the runtime's packages importable from a proposal.
 *
 * A proposal that wants `defineTool` or a TypeBox schema has to import them,
 * and the proposals directory is not under the runtime's `node_modules`. A
 * symlink is the whole of the fix; if it cannot be made, an extension that
 * needs no imports still works.
 */
export function linkRuntimeModules(dir, runtimeModules) {
  const target = path.join(dir, 'node_modules');
  try {
    if (lstatSync(target, { throwIfNoEntry: false })) return true;
  } catch { /* fall through to the mkdir */ }
  try {
    mkdirSync(dir, { recursive: true });
    symlinkSync(runtimeModules, target, 'dir');
    return true;
  } catch {
    return false;
  }
}

/** The runtime's own node_modules, next to this file. */
export function runtimeModulesDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules');
}

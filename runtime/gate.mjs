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
// change an explicit, recorded act.
//
// What it does NOT stop, and does not pretend to stop:
//
//   * The agent runs in this process, with this process's uid. It can write
//     the ledger (it lives in the agent's own HOME), it can call the install
//     route itself, and it can run `bash`. Nothing here contains a malicious
//     agent, and the plan says so in §2.8: a real boundary is a separate
//     spike (a second app package with its own uid).
//   * The guardrail is for the ordinary case: the agent writes an extension
//     through the sanctioned path, and the user gets to see it first.
//
// What the gate does buy, concretely:
//
//   * the user sees the whole file, its hash and its diff before it runs;
//   * the hash is what is approved, and the bytes that are imported are the
//     bytes that were hashed, so a file that changes in between is refused;
//   * a proposal cannot take over the app's own extensions or tools;
//   * a proposal the user refused stays refused, so the agent cannot propose
//     the same file in a loop;
//   * the kernel's extensions survive a bridge restart, and a file that
//     changed while the bridge was down is *not* silently reinstalled.
//
// The hot install works because pi-durable reads the registry when it
// resolves an agent, not when the harness opens: a newly installed extension
// is in the next turn's tool list, with no restart and no lost session.

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { structuredPatch } from 'diff';

/** The names the app's own extensions use. A proposal may not take them:
 *  the registry replaces by name, so a proposal called `coding-tools` would
 *  remove the kernel's own read/write/edit/bash. */
export const RESERVED_EXTENSIONS = ['coding-tools', 'subagent', 'install-gate'];

/** The gate's own tool. */
export const GATE_TOOL = 'extension_propose';

/** The file names a proposal may have. A `.js` file is CommonJS unless a
 *  package.json above it says otherwise, so `.mjs` is the one to write. */
export const PROPOSAL_SUFFIXES = ['.mjs', '.js'];

/** A proposal bigger than this is not a proposal; it is a mistake. */
export const MAX_PROPOSAL_BYTES = 256 * 1024;

/** The keys an extension may have. Anything else is refused, by name: a file
 *  that asks for a hook and does not get one is a file the user approved and
 *  the kernel did not install. */
const ACCEPTED_KEYS = new Set(['name', 'tools', 'sections']);

/** Why a key is refused, where there is something better to say. */
const REFUSED_KEYS = {
  tasks: 'a task is scheduled by the kernel; v1 installs tools and sections only',
  wraps: 'a wrap intercepts other tools; v1 installs tools and sections only',
  hooks: 'a hook runs around every tool call; v1 installs tools and sections only',
};

/** The section key pi-durable reserves for the agent's instructions. A
 *  proposal may not take it: the registry refuses it, and it is better to
 *  say so before the file runs. */
const RESERVED_SECTION_KEY = 'instructions';

/** Extension names, tool names and section keys: lowercase, then letters,
 *  digits, dash and underscore. The same rule the registry uses for sections. */
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

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
 * The diff is `diff`'s — the package pi-durable already ships — so it is the
 * one everybody else uses, down to the `@@ -a,b +c,d @@` headers and the
 * marker for a last line with no newline.
 */
export function diffLines(before, after, { context = 3 } = {}) {
  const patch = structuredPatch(
    'a', 'b', String(before ?? ''), String(after ?? ''), undefined, undefined, { context },
  );
  if (!patch.hunks.length) return '';
  const out = [];
  for (const hunk of patch.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    out.push(...hunk.lines);
  }
  return out.join('\n');
}

/**
 * Check a module for the shape of an extension, and build the extension the
 * registry can take.
 *
 * The rules are deliberately narrow, because the code is kernel code:
 *
 *   * a name, lowercase, and not one of the app's own
 *   * tools: a name, a description, a JSON schema for the parameters, a
 *     function to run, and a name the kernel is not already using
 *   * sections: a key and a render function
 *
 * `tasks`, `wraps` and `hooks` are refused. A task is scheduled by the
 * kernel, a wrap intercepts other tools and a hook runs around every tool
 * call: all three are a much larger surface than a tool, and v1 does not
 * need them.
 *
 * Every tool is installed with `replay: 'unsafe'`. That is pi-durable's own
 * default, and it is the right one here: 'safe' means the tool may run AGAIN
 * after a crash, and nobody can show that agent-written code is safe to run
 * twice.
 */
export function validateExtension(mod, { reservedExtensions = RESERVED_EXTENSIONS, reservedTools = new Set() } = {}) {
  const problems = [];
  const candidate = unwrap(mod);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { extension: null, problems: ['the file does not export an extension object'] };
  }
  for (const key of Object.keys(candidate)) {
    if (ACCEPTED_KEYS.has(key)) continue;
    problems.push(REFUSED_KEYS[key] ?? `"${key}" is not something v1 installs`);
  }
  const name = candidate.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    problems.push('the extension needs a name: lowercase letters, then letters, digits, - or _');
  } else if (reservedExtensions.includes(name)) {
    problems.push(`"${name}" is the app's own extension; a proposal may not take its name`);
  }

  const tools = [];
  if (candidate.tools !== undefined) {
    if (!Array.isArray(candidate.tools)) {
      problems.push('tools must be an array');
    } else {
      const names = new Set();
      candidate.tools.forEach((tool, index) => {
        if (!tool || typeof tool !== 'object') {
          problems.push(`tool ${index} is not an object`);
          return;
        }
        if (typeof tool.name !== 'string' || !NAME_RE.test(tool.name)) {
          problems.push(`tool ${index} needs a name: lowercase letters, then letters, digits, - or _`);
        } else if (reservedTools.has(tool.name)) {
          problems.push(`the tool "${tool.name}" is already in the kernel; a proposal may not take it over`);
        } else if (names.has(tool.name)) {
          // pi-durable refuses this too, but it refuses it AFTER the file has
          // run: the gate says it first.
          problems.push(`the extension has two tools named "${tool.name}"`);
        }
        names.add(tool.name);
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
        } else if (sec.key === RESERVED_SECTION_KEY) {
          problems.push(`the section key "${RESERVED_SECTION_KEY}" is reserved by the kernel`);
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
    if (parsed === null && existsSync(this.#stateFile)) {
      // A ledger that does not parse is not a ledger: the installed
      // extensions are forgotten, and the user has to be told rather than
      // find out from a sheet that says "none installed".
      console.error(`the extensions ledger at ${this.#stateFile} does not parse; it is ignored`);
    }
    if (parsed && parsed.version !== undefined && parsed.version !== 1) {
      // A ledger from another version is not read as if it were this one.
      console.error(`the extensions ledger is version ${parsed.version}; it is ignored`);
      parsed = null;
    }
    this.#state = {
      version: 1,
      installed: parsed?.installed && typeof parsed.installed === 'object' ? parsed.installed : {},
      rejected: parsed?.rejected && typeof parsed.rejected === 'object' ? parsed.rejected : {},
      failed: parsed?.failed && typeof parsed.failed === 'object' ? parsed.failed : {},
      proposed: parsed?.proposed && typeof parsed.proposed === 'object' ? parsed.proposed : {},
    };
    return this.#state;
  }

  #save() {
    if (!this.#stateFile) return;
    mkdirSync(path.dirname(this.#stateFile), { recursive: true });
    // A name nobody can guess, and 'wx' so a file that is already there is an
    // error rather than something the agent prepared.
    const tmp = `${this.#stateFile}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, this.#stateFile);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* it was never written */ }
      throw error;
    }
  }

  /**
   * The path a key names, refusing anything outside the proposals dir.
   *
   * The agent's working directory is the workspace, so it may well say
   * "extensions/foo.mjs"; both spellings name the same file.
   */
  resolve(key) {
    let name = String(key ?? '');
    if (!name) throw new GateError(400, 'no file named');
    if (name.startsWith('extensions/')) name = name.slice('extensions/'.length);
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

  /**
   * The proposal files: the ones the agent proposed.
   *
   * A file that is in the directory but was never proposed is not a proposal:
   * a helper module next to an extension would otherwise show up as
   * something to install, and fail.
   */
  files() {
    const out = [];
    for (const key of Object.keys(this.state.proposed)) {
      let file;
      try { file = this.resolve(key); } catch { continue; }
      if (!existsSync(file)) continue;
      out.push(file);
    }
    return out.sort();
  }

  /**
   * What is in a file right now: its text, its hash, and its size.
   *
   * A symlink is resolved first: a link in the proposals directory that
   * points outside it is not a proposal.
   */
  read(file) {
    const real = realpathSync(file);
    if (real !== this.#dir && !real.startsWith(this.#dir + path.sep)) {
      throw new GateError(400, 'the file resolves outside the extensions directory');
    }
    const stat = statSync(real);
    if (!stat.isFile()) throw new GateError(400, 'not a file');
    if (stat.size > MAX_PROPOSAL_BYTES) {
      throw new GateError(400, `the file is ${stat.size} bytes; a proposal may be at most ${MAX_PROPOSAL_BYTES}`);
    }
    const text = readFileSync(real, 'utf8');
    return { text, hash: sha256(text), bytes: stat.size };
  }

  /**
   * The state of one proposal: pending, installed, rejected, changed since
   * it was installed, or failed.
   */
  statusOf(file) {
    const key = this.keyOf(file);
    return this.#status(key, this.read(file));
  }

  /** The state of a proposal, from what was just read. */
  #status(key, current) {
    const base = { key, hash: current.hash, bytes: current.bytes };
    const installed = this.state.installed[key];
    if (installed && installed.hash === current.hash) return { ...base, state: 'installed', installed };
    if (this.state.rejected[key] === current.hash) return { ...base, state: 'rejected' };
    if (installed) return { ...base, state: 'changed', installed };
    const failed = this.state.failed[key];
    if (failed && failed.hash === current.hash) return { ...base, state: 'failed' };
    return { ...base, state: 'pending' };
  }

  /**
   * Every proposal, with what the user is shown: the whole file, its hash,
   * and the diff against the version that was installed.
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
        diff: diffLines(installed?.content ?? '', current.text),
        // The whole file, so that nothing is ever approved unseen.
        content: current.text,
        error: status.state === 'failed' ? (this.state.failed[key]?.error ?? null) : null,
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
   * The proposals that could not be installed, and why.
   *
   * A file that fails to load, or that the kernel no longer accepts, is
   * here: the user has to be told, or the sheet says "installed" for
   * something that is not.
   */
  problems() {
    const out = Object.entries(this.state.failed).map(([key, rec]) => ({
      key,
      hash: rec.hash ?? null,
      error: rec.error ?? 'unknown error',
      at: rec.at ?? null,
      gone: !existsSync(this.resolve(key)),
    }));
    // A proposal whose file is gone is a problem too.
    for (const key of Object.keys(this.state.proposed)) {
      if (this.state.failed[key]) continue;
      let file;
      try { file = this.resolve(key); } catch { continue; }
      if (!existsSync(file)) out.push({ key, hash: null, error: 'the file is gone', at: null, gone: true });
    }
    return out;
  }

  /**
   * Record that the agent wants this file installed, and say where it
   * stands. This is what the agent's tool calls.
   *
   * Every path tells the client: the sheet has to learn that something is
   * waiting, including the ordinary case of a file that changed after it
   * was installed.
   */
  propose(key) {
    const file = this.resolve(key);
    if (!existsSync(file)) throw new GateError(404, `no such file: ${key}`);
    if (!PROPOSAL_SUFFIXES.includes(path.extname(file))) {
      throw new GateError(400, `a proposal is a ${PROPOSAL_SUFFIXES.join(' or ')} file`);
    }
    const status = this.statusOf(file);
    // The proposal is recorded, so the sheet knows this file is one. A file
    // the agent wrote and never proposed is not on the sheet.
    this.state.proposed[status.key] = { hash: status.hash, at: this.#now() };
    this.#save();
    this.#onChange();
    switch (status.state) {
      case 'installed':
        return { ...status, message: `${status.key} is installed (${shortHash(status.hash)}).` };
      case 'rejected':
        return { ...status, message: `${status.key} was rejected by the user (${shortHash(status.hash)}). Change the file before proposing it again.` };
      case 'changed':
        return { ...status, message: `${status.key} changed since it was installed. The user has to approve the new version.` };
      case 'failed':
        return { ...status, message: `${status.key} does not install: ${this.state.failed[status.key]?.error ?? 'unknown error'}. Fix the file and propose it again.` };
      default:
        return {
          ...status,
          message: `${status.key} is proposed (sha256 ${shortHash(status.hash)}). The user has to approve it in the Extensions sheet before it runs.`,
        };
    }
  }

  /**
   * Install a proposal: import it, check it, and put it in the registry.
   *
   * `expectedHash` is the hash the user was shown, and it is required: the
   * user approved a file, not a name. The bytes that are imported are the
   * bytes that were hashed, so a file that changes in the meantime cannot
   * slip in under the approval.
   */
  async install(key, expectedHash) {
    if (!expectedHash) throw new GateError(400, 'the hash is required: approve the file you were shown');
    const file = this.resolve(key);
    if (!existsSync(file)) throw new GateError(404, `no such file: ${key}`);
    if (!this.state.proposed[this.keyOf(file)]) {
      throw new GateError(400, 'that file was not proposed; nothing to approve');
    }
    const { text, hash } = this.read(file);
    if (expectedHash !== hash) {
      throw new GateError(409, 'the file changed since you approved it; look at it again');
    }
    let mod;
    try {
      mod = await this.#importApproved(file, text, hash);
    } catch (error) {
      const why = String(error?.message ?? error);
      this.#fail(key, hash, `the file does not load: ${why}`);
      throw new GateError(400, `the file does not load: ${why}`);
    }
    const candidate = unwrap(mod);
    const { extension, problems } = validateExtension(mod, {
      reservedTools: this.#toolsInUse(typeof candidate?.name === 'string' ? candidate.name : null),
    });
    if (problems.length) {
      const why = problems.join('; ');
      this.#fail(key, hash, why);
      throw new GateError(400, why);
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
    delete this.state.failed[key];
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
    delete this.state.failed[key];
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
   * approved a hash, and the file is not that hash any more. It shows up as
   * a proposal again, which is the honest reading.
   */
  async restore() {
    const results = [];
    for (const [key, record] of Object.entries(this.state.installed)) {
      let file;
      try {
        file = this.resolve(key);
      } catch (error) {
        this.#drop(key, record, String(error?.message ?? error));
        results.push({ key, name: record.name, ok: false, error: String(error?.message ?? error) });
        continue;
      }
      if (!existsSync(file)) {
        this.#drop(key, record, 'the file is gone');
        results.push({ key, name: record.name, ok: false, error: 'the file is gone' });
        continue;
      }
      let current;
      try {
        current = this.read(file);
      } catch (error) {
        const why = String(error?.message ?? error);
        this.#drop(key, record, why);
        results.push({ key, name: record.name, ok: false, error: why });
        continue;
      }
      if (current.hash !== record.hash) {
        this.#drop(key, record, 'the file changed since it was approved');
        results.push({ key, name: record.name, ok: false, error: 'the file changed since it was approved' });
        continue;
      }
      // The ledger keeps the content it approved. If the file and the ledger
      // disagree, neither one is an approval of the other.
      if (typeof record.content === 'string' && record.content !== current.text) {
        this.#drop(key, record, 'the file no longer matches what was approved');
        results.push({ key, name: record.name, ok: false, error: 'the file no longer matches what was approved' });
        continue;
      }
      try {
        const mod = await this.#importApproved(file, current.text, current.hash);
        const { extension, problems } = validateExtension(mod, {
          reservedTools: this.#toolsInUse(record.name),
        });
        if (problems.length) throw new Error(problems.join('; '));
        this.#registry?.install(extension);
        results.push({ key, name: extension.name, ok: true });
      } catch (error) {
        const why = String(error?.message ?? error);
        this.#drop(key, record, why);
        results.push({ key, name: record.name, ok: false, error: why });
      }
    }
    return results;
  }

  /** The tool names the kernel is already using. */
  #toolsInUse(excludeName) {
    const names = new Set();
    const snapshot = this.#registry?.snapshot();
    for (const { extension, tool } of snapshot?.tools() ?? []) {
      // The extension being replaced does not count against itself.
      if (excludeName && extension.name === excludeName) continue;
      names.add(tool.name);
    }
    return names;
  }

  /** Remember that a proposal does not install, and why. */
  #fail(key, hash, error) {
    this.state.failed[key] = { hash, error, at: this.#now() };
    this.#save();
    this.#onChange();
  }

  /**
   * Take a record out of the ledger: it is not installed any more, and the
   * reason is kept so the sheet can say what happened.
   */
  #drop(key, record, error) {
    delete this.state.installed[key];
    this.state.failed[key] = { hash: record.hash ?? null, error, at: this.#now() };
    this.#save();
    this.#onChange();
  }

  /**
   * Import the bytes that were approved.
   *
   * Not the path: the agent runs in this process and can rewrite the file
   * between the hash check and the import. The approved text is written to a
   * shadow file beside the original — so a relative import still resolves,
   * and the bare imports still find the runtime's packages — and *that* is
   * what is imported.
   */
  async #importApproved(file, text, hash) {
    const shadow = path.join(
      path.dirname(file),
      `.installing-${hash.slice(0, 12)}-${randomBytes(4).toString('hex')}.mjs`,
    );
    writeFileSync(shadow, text, { mode: 0o600 });
    try {
      return await import(`${pathToFileURL(shadow).href}?v=${hash}`);
    } finally {
      try { unlinkSync(shadow); } catch { /* the module is already in memory */ }
    }
  }
}

/**
 * The tool the agent uses to propose an extension.
 *
 * The gate itself is server-owned: the agent can ask, and it is told where
 * the proposal stands, but it cannot install anything. The user taps
 * Install.
 */
export function gateExtension(gate) {
  return {
    name: 'install-gate',
    tools: [{
      name: GATE_TOOL,
      description: [
        'Propose an extension file for the user to install.',
        '',
        `Write the extension to ${gate.dir}/ and call this tool with its file name.`,
        'The user is shown the file, its sha256 and its diff, and has to approve it',
        'before it runs. The extension is kernel code: it runs inside the bridge',
        "process, with the bridge's permissions. It cannot be installed any other way.",
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: { file: { type: 'string', description: 'The file name, inside the extensions directory.' } },
        required: ['file'],
        additionalProperties: false,
      },
      replay: 'safe', // it only records a proposal; a rerun records the same one
      execute: async (args) => {
        const said = gate.propose(String(args.file ?? ''));
        return { content: [{ type: 'text', text: said.message }] };
      },
    }],
  };
}

/**
 * The runtime's own node_modules, next to this file.
 *
 * The gate does NOT link it into the proposals directory: a link to the
 * kernel's own packages inside a directory the agent can write to is a way
 * into the kernel's packages, and the plan's boundary is a separate package
 * with its own uid, not a symlink. An extension that needs nothing from the
 * runtime needs nothing from the runtime: `defineTool` is an identity
 * function, and a tool's parameters are a plain JSON schema.
 */
export function runtimeModulesDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules');
}

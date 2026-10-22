// gate.mjs — the install gate.
//
// The gate decides whether agent-written code runs inside the kernel. It is an
// accident guardrail: the user is shown the file, its hash and its diff, and
// only what they approve is installed. It is not a sandbox — see gate.mjs.
//
//   node test/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  diffLines, GateError, InstallGate, MAX_PROPOSAL_BYTES, sha256, shortHash, validateExtension,
} from '../runtime/gate.mjs';

/** A directory with a proposals dir in it, and the state file beside it. */
function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'gate-'));
  const dir = path.join(root, 'extensions');
  mkdirSync(dir, { recursive: true });
  const stateFile = path.join(root, 'extensions.json');
  return {
    root, dir, stateFile,
    write: (name, content) => {
      const file = path.join(dir, name);
      writeFileSync(file, content);
      return file;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A registry that records what was installed, like pi-durable's. */
function fakeRegistry() {
  const installed = new Map();
  return {
    installed,
    install(extension) { installed.set(extension.name, extension); },
    uninstall(extension) { installed.delete(extension.name); },
    snapshot() {
      return { extension: (name) => installed.get(name), installed: () => [...installed.values()] };
    },
  };
}

const GOOD = `export default {
  name: 'greeter',
  tools: [{
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
    replay: 'safe',
    execute: async (args) => ({ content: [{ type: 'text', text: 'hi ' + args.who }] }),
  }],
};
`;

// --- the hash ------------------------------------------------------------------

test('the hash is the hash of the bytes, and the short form is a prefix', () => {
  const hash = sha256('hello');
  assert.equal(hash.length, 64);
  assert.equal(hash, sha256('hello'));
  assert.notEqual(hash, sha256('hello '));
  assert.equal(shortHash(hash), hash.slice(0, 12));
});

// --- the diff -----------------------------------------------------------------

test('a new file is all additions', () => {
  const diff = diffLines('', 'one\ntwo\n');
  assert.match(diff, /^@@ /m);
  assert.match(diff, /\+one/);
  assert.match(diff, /\+two/);
  assert.ok(!diff.includes('-one'));
});

test('an unchanged file has no diff', () => {
  assert.equal(diffLines('same\n', 'same\n'), '');
});

test('a changed line is shown as a removal and an addition', () => {
  const diff = diffLines('a\nb\nc\n', 'a\nB\nc\n');
  assert.match(diff, /-b/);
  assert.match(diff, /\+B/);
  assert.match(diff, / a/);
  assert.match(diff, / c/);
});

test('the hunk header counts the lines on each side', () => {
  const diff = diffLines('a\nb\nc\n', 'a\nB\nc\n');
  const header = diff.split('\n').find((l) => l.startsWith('@@'));
  assert.equal(header, '@@ -1,3 +1,3 @@');
});

test('a diff far from the change keeps three lines of context', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 10', 'line ten');
  const diff = diffLines(before, after);
  assert.ok(!diff.includes('line 0'), 'the far context is not in the diff');
  assert.match(diff, /-line 10/);
  assert.match(diff, /\+line ten/);
});

// --- the validation ------------------------------------------------------------

test('a good extension is accepted, and its tools are forced to unsafe', () => {
  const { extension, problems } = validateExtension({ name: 'greeter', tools: [{
    name: 'greet', description: 'Greet.', parameters: { type: 'object' }, replay: 'safe',
    execute: async () => ({ content: [] }),
  }] });
  assert.deepEqual(problems, []);
  assert.equal(extension.name, 'greeter');
  // The file said "safe"; the gate does not believe it. Agent-written code
  // cannot be shown to be safe to run twice.
  assert.equal(extension.tools[0].replay, 'unsafe');
});

test('a default export is the extension', () => {
  const { extension, problems } = validateExtension({ default: { name: 'greeter' } });
  assert.deepEqual(problems, []);
  assert.equal(extension.name, 'greeter');
});

test('a file that exports nothing is refused', () => {
  const { extension, problems } = validateExtension({ nothing: true });
  assert.equal(extension, null);
  assert.equal(problems.length, 1);
});

test('a name that is not a plain lowercase name is refused', () => {
  for (const name of ['Greeter', '1greeter', 'gre eter', '', 'a'.repeat(65)]) {
    const { problems } = validateExtension({ name });
    assert.ok(problems.length, `${JSON.stringify(name)} was accepted`);
  }
});

test('a tool without a description, a schema or an execute is refused', () => {
  const { problems } = validateExtension({ name: 'x', tools: [{ name: 't' }] });
  assert.equal(problems.length, 3);
});

test('tasks and wraps are refused in v1', () => {
  const { problems } = validateExtension({ name: 'x', tasks: [], wraps: [] });
  assert.equal(problems.length, 2);
});

// --- the gate ------------------------------------------------------------------

test('a proposal is pending until it is installed', async () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    const proposals = gate.proposals();
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].key, 'greeter.mjs');
    assert.equal(proposals[0].state, 'pending');
    assert.equal(proposals[0].hash, sha256(GOOD));
    assert.ok(proposals[0].diff.includes("+  name: 'greeter',"), proposals[0].diff);
  } finally {
    box.cleanup();
  }
});

test('a file that is not a proposal is not listed', () => {
  const box = sandbox();
  try {
    box.write('notes.txt', 'hello');
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    assert.deepEqual(gate.proposals().map((p) => p.key), ['greeter.mjs']);
  } finally {
    box.cleanup();
  }
});

test('installing puts the extension in the registry and remembers it', async () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const registry = fakeRegistry();
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry });
    const result = await gate.install('greeter.mjs', sha256(GOOD));
    assert.equal(result.name, 'greeter');
    assert.deepEqual(result.tools, ['greet']);
    assert.ok(registry.installed.has('greeter'));
    // The state is on disk, not just in memory: a restart reads it back.
    const state = JSON.parse(readFileSync(box.stateFile, 'utf8'));
    assert.equal(state.installed['greeter.mjs'].hash, sha256(GOOD));
    assert.equal(gate.proposals()[0].state, 'installed');
  } finally {
    box.cleanup();
  }
});

test('an install without the hash the user saw is refused', async () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const registry = fakeRegistry();
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry });
    // The user approved a file, not a name: the hash is what says which file.
    await assert.rejects(() => gate.install('greeter.mjs'), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /hash/);
      return true;
    });
    assert.equal(registry.installed.size, 0);
  } finally {
    box.cleanup();
  }
});

test('a second file with the same extension name replaces the first', async () => {
  const box = sandbox();
  try {
    box.write('one.mjs', GOOD);
    box.write('two.mjs', GOOD);
    const registry = fakeRegistry();
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry });
    await gate.install('one.mjs', sha256(GOOD));
    await gate.install('two.mjs', sha256(GOOD));
    // One name, one extension: the first file is not installed any more.
    assert.deepEqual(gate.installed().map((e) => e.key), ['two.mjs']);
    assert.equal(registry.installed.size, 1);
  } finally {
    box.cleanup();
  }
});

test('a file that changed since the user approved it is refused', async () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    const seen = gate.proposals()[0].hash;
    // The agent rewrites the file after the user was shown it.
    box.write('greeter.mjs', GOOD.replace('Greet someone', 'Greet a person'));
    await assert.rejects(() => gate.install('greeter.mjs', seen), (error) => {
      assert.ok(error instanceof GateError);
      assert.equal(error.status, 409);
      return true;
    });
  } finally {
    box.cleanup();
  }
});

test('an extension that does not validate is refused, and nothing is installed', async () => {
  const box = sandbox();
  try {
    box.write('broken.mjs', 'export default { name: "Broken" };\n');
    const registry = fakeRegistry();
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry });
    await assert.rejects(() => gate.install('broken.mjs', sha256('export default { name: "Broken" };\n')), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /name/);
      return true;
    });
    assert.equal(registry.installed.size, 0);
  } finally {
    box.cleanup();
  }
});

test('a path outside the extensions directory is refused', async () => {
  const box = sandbox();
  try {
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    await assert.rejects(() => gate.install('../escape.mjs', sha256('x')), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /outside/);
      return true;
    });
  } finally {
    box.cleanup();
  }
});

test('a rejected proposal is remembered, and the agent is told', () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    const hash = gate.proposals()[0].hash;
    gate.reject('greeter.mjs', hash);
    assert.equal(gate.proposals()[0].state, 'rejected');
    const said = gate.propose('greeter.mjs');
    assert.match(said.message, /rejected/);
    // A different file is a different proposal.
    box.write('other.mjs', GOOD.replace('greeter', 'other'));
    assert.equal(gate.proposals().find((p) => p.key === 'other.mjs').state, 'pending');
  } finally {
    box.cleanup();
  }
});

test('a rejected proposal is a proposal again once the file changes', () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    gate.reject('greeter.mjs', gate.proposals()[0].hash);
    box.write('greeter.mjs', GOOD.replace('Greet someone', 'Greet a person'));
    assert.equal(gate.proposals()[0].state, 'pending');
  } finally {
    box.cleanup();
  }
});

test('uninstalling takes the extension back out of the registry', async () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const registry = fakeRegistry();
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry });
    await gate.install('greeter.mjs', sha256(GOOD));
    assert.ok(registry.installed.has('greeter'));
    gate.uninstall('greeter.mjs');
    assert.equal(registry.installed.size, 0);
    assert.equal(gate.proposals()[0].state, 'pending');
  } finally {
    box.cleanup();
  }
});

test('a restart installs what was installed', async () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const first = fakeRegistry();
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: first });
    await gate.install('greeter.mjs', sha256(GOOD));

    // A new process, the same state file: the extension is back.
    const second = fakeRegistry();
    const restarted = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: second });
    const results = await restarted.restore();
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.ok(second.installed.has('greeter'));
  } finally {
    box.cleanup();
  }
});

test('a restart does not install a file that changed since it was approved', async () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    await gate.install('greeter.mjs', sha256(GOOD));
    box.write('greeter.mjs', GOOD.replace('Greet someone', 'Greet a person'));

    const second = fakeRegistry();
    const restarted = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: second });
    const results = await restarted.restore();
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /changed/);
    assert.equal(second.installed.size, 0);
    // And it is a proposal again, waiting for the user.
    assert.equal(restarted.proposals()[0].state, 'changed');
  } finally {
    box.cleanup();
  }
});

test('a proposal bigger than the limit is refused', () => {
  const box = sandbox();
  try {
    box.write('big.mjs', 'x'.repeat(MAX_PROPOSAL_BYTES + 1));
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    assert.throws(() => gate.propose('big.mjs'), (error) => {
      assert.equal(error.status, 400);
      return true;
    });
  } finally {
    box.cleanup();
  }
});

test('the state file is written atomically, so a crash cannot truncate it', () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    gate.propose('greeter.mjs');
    // The temporary file is gone, and the state parses.
    assert.ok(!existsSync(`${box.stateFile}.${process.pid}.tmp`));
    assert.doesNotThrow(() => JSON.parse(readFileSync(box.stateFile, 'utf8')));
  } finally {
    box.cleanup();
  }
});

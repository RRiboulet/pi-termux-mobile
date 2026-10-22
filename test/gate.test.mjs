// gate.mjs — the install gate.
//
// The gate decides whether agent-written code runs inside the kernel. It is an
// accident guardrail: the user is shown the file, its hash and its diff, and
// only what they approve is installed. It is not a sandbox — see gate.mjs.
//
//   node test/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync,
} from 'node:fs';
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

/**
 * A registry that records what was installed, like pi-durable's.
 *
 * The shape matters: the gate reads `snapshot().tools()` to know which tool
 * names are taken, so a fake that does not have it would let the gate pass
 * tests the real registry would fail.
 */
function fakeRegistry() {
  const installed = new Map();
  return {
    installed,
    install(extension) { installed.set(extension.name, extension); },
    uninstall(extension) { installed.delete(extension.name); },
    snapshot() {
      return {
        extension: (name) => installed.get(name),
        installed: () => [...installed.values()],
        tools: () => [...installed.values()].flatMap((extension) =>
          (extension.tools ?? []).map((tool) => ({ extension, tool }))),
      };
    },
  };
}


/** The sanctioned path, in two steps: the agent proposes, the user approves. */
async function approve(gate, key, text) {
  gate.propose(key);
  return gate.install(key, sha256(text));
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

test('a file whose last line has no newline says so, once per side', () => {
  const diff = diffLines('x', 'y');
  const markers = diff.split('\n').filter((l) => l.includes('No newline'));
  assert.equal(markers.length, 2, diff);
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
  // Two problems: the key is not one v1 installs, and there is no name.
  assert.equal(problems.length, 2);
  assert.match(problems[0], /nothing/);
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

test('a hook is refused by name, not dropped in silence', () => {
  // A file the user approved and the kernel did not install is worse than a
  // refusal: the user thinks they approved something that is not running.
  const { problems } = validateExtension({ name: 'x', hooks: {} });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /hook/);
});

test('an unknown key is refused by name', () => {
  const { problems } = validateExtension({ name: 'x', instructions: 'do things' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /instructions/);
});

test("the app's own extension names are reserved", () => {
  for (const name of ['coding-tools', 'subagent', 'install-gate']) {
    const { problems } = validateExtension({ name });
    assert.ok(problems.length, `${name} was accepted`);
    assert.match(problems[0], /app's own/);
  }
});

test('a tool the kernel already has cannot be taken over', () => {
  const { problems } = validateExtension(
    { name: 'x', tools: [{ name: 'bash', description: 'd', parameters: { type: 'object' }, execute: async () => ({ content: [] }) }] },
    { reservedTools: new Set(['bash']) },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /already in the kernel/);
});

// --- the gate ------------------------------------------------------------------

test('a proposal is pending until it is installed', async () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    gate.propose('greeter.mjs');
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

test('a file that was not proposed is not listed', () => {
  const box = sandbox();
  try {
    box.write('notes.txt', 'hello');
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    // A helper module next to an extension is not a proposal: the agent
    // proposes what it wants installed.
    assert.deepEqual(gate.proposals().map((p) => p.key), []);
    gate.propose('greeter.mjs');
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
    const result = await approve(gate, 'greeter.mjs', GOOD);
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
    await approve(gate, 'one.mjs', GOOD);
    await approve(gate, 'two.mjs', GOOD);
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
    gate.propose('greeter.mjs');
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
    gate.propose('broken.mjs');
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
    gate.propose('greeter.mjs');
    const hash = gate.proposals()[0].hash;
    gate.reject('greeter.mjs', hash);
    assert.equal(gate.proposals()[0].state, 'rejected');
    const said = gate.propose('greeter.mjs');
    assert.match(said.message, /rejected/);
    // A different file is a different proposal.
    box.write('other.mjs', GOOD.replace('greeter', 'other'));
    gate.propose('other.mjs');
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
    gate.propose('greeter.mjs');
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
    await approve(gate, 'greeter.mjs', GOOD);
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
    await approve(gate, 'greeter.mjs', GOOD);

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
    await approve(gate, 'greeter.mjs', GOOD);
    box.write('greeter.mjs', GOOD.replace('Greet someone', 'Greet a person'));

    const second = fakeRegistry();
    const restarted = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: second });
    const results = await restarted.restore();
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /changed/);
    assert.equal(second.installed.size, 0);
    // It is not installed any more, so it is an ordinary proposal again —
    // and the reason it was dropped is still on the record.
    assert.equal(restarted.proposals()[0].state, 'pending');
    assert.match(restarted.problems()[0].error, /changed/);
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

test('the state file is written atomically, so a crash cannot truncate it', async () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    await approve(gate, 'greeter.mjs', GOOD);
    // The temporary file is gone, and the state parses.
    assert.ok(!existsSync(`${box.stateFile}.${process.pid}.tmp`));
    assert.doesNotThrow(() => JSON.parse(readFileSync(box.stateFile, 'utf8')));
  } finally {
    box.cleanup();
  }
});

// --- the fixes the review found ------------------------------------------------

test('the bytes that are imported are the bytes that were approved', async () => {
  const box = sandbox();
  try {
    // The extension reads its own source at import time and puts it in the
    // tool's description. What it read is what was imported.
    const SELF = `import { readFileSync } from 'node:fs';
const self = readFileSync(new URL(import.meta.url), 'utf8');
export default {
  name: 'selfread',
  tools: [{
    name: 'selfread_show',
    description: self,
    parameters: { type: 'object' },
    execute: async () => ({ content: [] }),
  }],
};
`;
    box.write('self.mjs', SELF);
    const registry = fakeRegistry();
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry });
    const hash = sha256(SELF);
    await approve(gate, 'self.mjs', SELF);
    const tool = registry.installed.get('selfread').tools[0];
    assert.equal(tool.description, SELF, 'the imported module was not the approved text');
  } finally {
    box.cleanup();
  }
});

test('the shadow file an install writes is cleaned up', async () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    await approve(gate, 'greeter.mjs', GOOD);
    const left = readdirSync(box.dir).filter((n) => n.startsWith('.installing-'));
    assert.deepEqual(left, [], 'the shadow file was left behind');
  } finally {
    box.cleanup();
  }
});

test('a proposal cannot take the name of an extension the kernel has', async () => {
  const box = sandbox();
  try {
    box.write('evil.mjs', GOOD.replace("name: 'greeter'", "name: 'coding-tools'"));
    const registry = fakeRegistry();
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry });
    gate.propose('evil.mjs');
    gate.propose('evil.mjs');
    await assert.rejects(() => gate.install('evil.mjs', sha256(GOOD.replace("name: 'greeter'", "name: 'coding-tools'"))), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /app's own extension/);
      return true;
    });
    assert.equal(registry.installed.size, 0);
  } finally {
    box.cleanup();
  }
});

test('a proposal cannot take over a tool the kernel already has', async () => {
  const box = sandbox();
  try {
    const TAKES = GOOD.replace("name: 'greet'", "name: 'bash'");
    box.write('evil.mjs', TAKES);
    const registry = fakeRegistry();
    registry.install({ name: 'coding-tools', tools: [{ name: 'bash' }] });
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry });
    gate.propose('evil.mjs');
    gate.propose('evil.mjs');
    await assert.rejects(() => gate.install('evil.mjs', sha256(TAKES)), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /already in the kernel/);
      return true;
    });
    assert.equal(registry.installed.size, 1);
  } finally {
    box.cleanup();
  }
});

test('a symlink out of the proposals directory is refused', () => {
  const box = sandbox();
  try {
    const outside = path.join(box.root, 'outside.mjs');
    writeFileSync(outside, GOOD);
    symlinkSync(outside, path.join(box.dir, 'link.mjs'));
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    // It is not even listed: a link out of the directory is not a proposal.
    assert.deepEqual(gate.proposals().map((p) => p.key), []);
    assert.throws(() => gate.propose('link.mjs'), (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /outside/);
      return true;
    });
  } finally {
    box.cleanup();
  }
});

test('a nested proposal is listed', () => {
  const box = sandbox();
  try {
    mkdirSync(path.join(box.dir, 'sub'), { recursive: true });
    writeFileSync(path.join(box.dir, 'sub', 'deep.mjs'), GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    gate.propose('sub/deep.mjs');
    assert.deepEqual(gate.proposals().map((p) => p.key), ['sub/deep.mjs']);
  } finally {
    box.cleanup();
  }
});

test('a proposal that does not install is remembered as failed, with the reason', async () => {
  const box = sandbox();
  try {
    const BROKEN = 'export default { name: "Broken" };\n';
    box.write('broken.mjs', BROKEN);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    gate.propose('broken.mjs');
    await assert.rejects(() => gate.install('broken.mjs', sha256(BROKEN)));
    const proposal = gate.proposals()[0];
    assert.equal(proposal.state, 'failed');
    assert.match(proposal.error, /name/);
    assert.equal(gate.problems().length, 1);
    // And the agent is told, so it can fix the file and propose again.
    assert.match(gate.propose('broken.mjs').message, /does not install/);
  } finally {
    box.cleanup();
  }
});

test('a proposal that changed after it was installed is announced', async () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const registry = fakeRegistry();
    let changes = 0;
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry, onChange: () => { changes++; } });
    await approve(gate, 'greeter.mjs', GOOD);
    changes = 0;
    box.write('greeter.mjs', GOOD.replace('Greet someone', 'Greet a person'));
    const said = gate.propose('greeter.mjs');
    assert.match(said.message, /changed since it was installed/);
    // The user has to be told: without this the sheet never learns that
    // something is waiting, and the self-building loop stalls.
    assert.ok(changes > 0, 'the client was not told about the changed proposal');
  } finally {
    box.cleanup();
  }
});

test('the ledger and the file have to agree before a restore installs anything', async () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    await approve(gate, 'greeter.mjs', GOOD);
    // A ledger edited by hand, saying a file was approved that it never saw.
    const state = JSON.parse(readFileSync(box.stateFile, 'utf8'));
    state.installed['greeter.mjs'].content = 'something else entirely';
    writeFileSync(box.stateFile, JSON.stringify(state));

    const second = fakeRegistry();
    const restarted = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: second });
    const results = await restarted.restore();
    assert.equal(results[0].ok, false);
    assert.equal(second.installed.size, 0);
  } finally {
    box.cleanup();
  }
});

test('a restore that cannot install says so, and does not leave the ledger lying', async () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    await approve(gate, 'greeter.mjs', GOOD);
    rmSync(path.join(box.dir, 'greeter.mjs'));

    const second = fakeRegistry();
    const restarted = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: second });
    const results = await restarted.restore();
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /gone/);
    // The sheet must not say "installed" for something that is not.
    assert.deepEqual(restarted.installed(), []);
    assert.equal(restarted.problems().length, 1);
  } finally {
    box.cleanup();
  }
});

test('the agent may name the file the way it sees it', () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    // The agent's cwd is the workspace, so "extensions/greeter.mjs" is what it
    // would naturally say.
    assert.match(gate.propose('extensions/greeter.mjs').message, /greeter\.mjs/);
  } finally {
    box.cleanup();
  }
});

test('the proposal carries the whole file, so nothing is approved unseen', () => {
  const box = sandbox();
  try {
    box.write('greeter.mjs', GOOD);
    const gate = new InstallGate({ dir: box.dir, stateFile: box.stateFile, registry: fakeRegistry() });
    gate.propose('greeter.mjs');
    assert.equal(gate.proposals()[0].content, GOOD);
  } finally {
    box.cleanup();
  }
});

// Reading the logs from inside the app.
//
// Until now the only way to find out why the bridge said "lost the connection" was
// to be at a shell on the phone. PiService appends node's output to
// files/log/node.log (rotating at 4 MB) and its own failures to
// service-error.txt; this checks the route that serves the tail of either, and
// that it cannot be walked out of.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeBinaryOrNode } from '../runtime/node-bin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the log route serves the tail of the two files it knows', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pi-log-'));
  const logDir = path.join(tmp, 'log');
  mkdirSync(logDir, { recursive: true });
  // Bigger than the 256 KB window the route reads, so the tail really is read from
  // the end of the file rather than by splitting the whole thing.
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${'x'.repeat(200)}`);
  appendFileSync(path.join(logDir, 'node.log'), lines.join('\n') + '\n');
  appendFileSync(path.join(logDir, 'service-error.txt'), 'Sat Oct 24 node exited 1; restarting\n');

  const child = spawn(nodeBinaryOrNode(), ['runtime/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HOME: path.join(tmp, 'home'), PI_WORKDIR: path.join(tmp, 'home', 'work'),
      PI_SHELL: '/bin/bash', PREFIX: process.env.PREFIX || '', PI_TEST_FAUX: '1',
      PI_PROVIDER: 'faux', PI_MODEL: 'faux-1', PI_PORT: '', PI_LOG_DIR: logDir },
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const stateDir = path.join(tmp, 'home', '.pi-mobile');
  const end = Date.now() + 60000;
  while (Date.now() < end && !(existsSync(path.join(stateDir, 'port')) && existsSync(path.join(stateDir, 'token')))) await sleep(50);
  if (!existsSync(path.join(stateDir, 'port'))) { child.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); throw new Error(`boot failed:\n${log}`); }
  const port = Number(readFileSync(path.join(stateDir, 'port'), 'utf8').trim());
  const token = readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  const get = async (q) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/log${q}`, { headers: { 'x-token': token } });
    return { status: r.status, body: await r.json() };
  };

  try {
    const tail = await get('?file=node&tail=5');
    assert.equal(tail.status, 200);
    assert.equal(tail.body.file, 'node');
    assert.equal(tail.body.lines.length, 5, 'the tail is not five lines');
    assert.match(tail.body.lines[4], /^line 3000 /, 'the last line is not the file’s last line');
    assert.match(tail.body.lines[0], /^line 2996 /, 'the five lines are not the last five');
    assert.equal(tail.body.truncated, true, 'a 600 KB file should report that it was read from the end');
    assert.ok(tail.body.bytes > 600000, `only ${tail.body.bytes} bytes`);

    // The other file, and only the other file.
    const service = await get('?file=service&tail=10');
    assert.equal(service.body.file, 'service');
    assert.deepEqual(service.body.lines, ['Sat Oct 24 node exited 1; restarting']);

    // Anything that is not the service file means the node log: no traversal, no
    // absolute paths, no .1 rotation, no surprises.
    for (const attempt of ['../service-error.txt', '/etc/passwd', 'node.log.1', 'service/../node']) {
      const out = await get(`?file=${encodeURIComponent(attempt)}&tail=3`);
      assert.equal(out.status, 200);
      assert.equal(out.body.file, 'node', `${attempt} was not treated as the node log`);
      assert.match(out.body.lines[0] ?? '', /^line /, `${attempt} read something else`);
    }

    // A file that does not exist is an empty log, not an error.
    rmSync(path.join(logDir, 'node.log'));
    const gone = await get('?file=node&tail=5');
    assert.equal(gone.status, 200);
    assert.equal(gone.body.missing, true);
    assert.deepEqual(gone.body.lines, []);
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    rmSync(tmp, { recursive: true, force: true });
  }
});

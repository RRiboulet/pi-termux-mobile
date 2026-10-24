// The client is fetched from the bridge on every page load, and the bridge is
// where an edit lands first: `cp app.js files/runtime/public/` is the deploy.
//
// That only works if a reload really is a reload. `no-store` fixes the response,
// but a WebView can still come back with the page it already had, and then the
// new file is never asked for. So the served index.html names its assets by
// their mtime, and this checks that it does -- a bad rewrite here is a blank app
// on the phone, which no unit test can see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeBinaryOrNode } from '../runtime/node-bin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the served page names its assets by version', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pi-static-'));
  const child = spawn(nodeBinaryOrNode(), ['runtime/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HOME: path.join(tmp, 'home'), PI_WORKDIR: path.join(tmp, 'home', 'work'),
      PI_SHELL: '/bin/bash', PREFIX: path.join(tmp, 'prefix'), PI_TEST_FAUX: '1',
      PI_PROVIDER: 'faux', PI_MODEL: 'faux-1' },
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

  try {
    const page = await fetch(`http://127.0.0.1:${port}/?token=${token}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text();

    for (const name of ['app.js', 'style.css']) {
      const tagged = `${name}?v=`;
      assert.ok(html.includes(tagged), `the served page does not version ${name}: ${html.match(new RegExp(`[^"]*${name}[^"]*`))?.[0] ?? 'not referenced'}`);
      const url = html.match(new RegExp(`(?:href|src)="([^"]*${name}\\?v=[^"]*)"`))[1];
      const asset = await fetch(`http://127.0.0.1:${port}/${url}?token=${token}`);
      assert.equal(asset.status, 200, `${url} is not served`);
      // The version is the mtime, so the URL really identifies the bytes on disk.
      const stamp = url.match(/\?v=([0-9a-z]+)/)[1];
      const mtime = Math.trunc(statSync(path.join(ROOT, 'runtime/public', name)).mtimeMs).toString(36);
      assert.equal(stamp, mtime, `${name} is versioned by something other than its mtime`);
      const bytes = Buffer.from(await asset.arrayBuffer());
      assert.deepEqual(bytes, readFileSync(path.join(ROOT, 'runtime/public', name)), `${url} does not serve the file on disk`);
    }

    // Nothing else is rewritten: the page still boots the same module.
    assert.match(html, /<script type="module" src="app\.js\?v=[0-9a-z]+"><\/script>/);
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    rmSync(tmp, { recursive: true, force: true });
  }
});

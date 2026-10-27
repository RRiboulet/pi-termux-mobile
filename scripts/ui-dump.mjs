// ui-dump.mjs — what the user would see, as text.
//
// A screenshot is a picture, and an agent that cannot look at pictures cannot
// use one. This renders the SAME client the phone runs (runtime/public/app.js)
// in a DOM, against the SAME frames the live bridge sends, and prints the
// result as a text tree: structure, labels, order, state.
//
//   node scripts/ui-dump.mjs              # the live bridge
//   node scripts/ui-dump.mjs --html       # ...and the raw innerHTML
//
// It is the mount from test/client.test.mjs, pointed at the running bridge
// instead of fixtures. The bridge is the source of truth; the client is the
// source of truth for what is drawn.
import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.HOME || os.homedir();
const STATE = path.join(HOME, '.pi-mobile');
const PUBLIC = path.resolve(process.env.PUBLIC_DIR || new URL('../runtime/public/', import.meta.url).pathname);
const wantHtml = process.argv.includes('--html');

const port = readFileSync(path.join(STATE, 'port'), 'utf8').trim();
const token = readFileSync(path.join(STATE, 'token'), 'utf8').trim();
const base = `http://127.0.0.1:${port}`;
const api = async (p) => {
  const r = await fetch(`${base}${p}`, { headers: { 'x-token': token } });
  return r.json();
};

/** The real frames: the bridge sends bridge_connected, then bridge_snapshot. */
async function captureFrames() {
  const frames = [];
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events?token=${encodeURIComponent(token)}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try { frames.push(JSON.parse(line.slice(5).trim())); } catch {}
    }
    if (frames.some((f) => f.type === 'bridge_snapshot')) break;
  }
  ac.abort();
  return frames;
}

const [state, models, providers, oauthProviders, usage, sessions, thinking, extensions] = await Promise.all([
  api('/api/state').catch(() => ({})),
  api('/api/models').catch(() => ({ models: [] })),
  api('/api/providers').catch(() => ({ providers: [] })),
  api('/api/oauth/providers').catch(() => ({ providers: [] })),
  api('/api/usage').catch(() => ({})),
  api('/api/sessions').catch(() => ({ sessions: [] })),
  api('/api/thinking').catch(() => ({})),
  api('/api/extensions').catch(() => ({})),
]);
const frames = await captureFrames();

// --- mount the real client ----------------------------------------------------
const { window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>');
const { document } = window;
let source = null;

globalThis.window = window;
globalThis.document = document;
globalThis.location = new URL(`http://127.0.0.1:${port}/?token=${token}`);
globalThis.history = { replaceState() {}, pushState() {}, back() {} };
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, v); } };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.EventSource = class {
  constructor(url) { this.url = url; source = this; }
  close() {}
};
globalThis.fetch = async (url) => {
  const u = String(url);
  const body = u.includes('/api/state') ? state
    : u.includes('/api/models') ? models
    : u.includes('/api/providers') ? providers
    : u.includes('/api/oauth/providers') ? oauthProviders
    : u.includes('/api/oauth/status') ? { done: true, events: [], prompt: null }
    : u.includes('/api/usage') ? usage
    : u.includes('/api/sessions') ? sessions
    : u.includes('/api/thinking') ? thinking
    : u.includes('/api/extensions') ? extensions
    : {};
  return { ok: true, status: 200, json: async () => body };
};

await import(`${PUBLIC}/app.js?v=${Math.random()}`);
await new Promise((r) => setTimeout(r, 60));
for (const f of frames) source.onmessage({ data: JSON.stringify(f) });
await new Promise((r) => setTimeout(r, 120));

const app = document.getElementById('app');
if (wantHtml) {
  console.log(app.innerHTML);
  process.exit(0);
}

// --- print it as a tree --------------------------------------------------------
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE']);
const INTERACTIVE = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A']);

function textOf(el) {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

function walk(el, depth) {
  for (const child of el.children) {
    if (SKIP.has(child.tagName)) continue;
    const cls = child.className && typeof child.className === 'string' ? '.' + child.className.trim().split(/\s+/).join('.') : '';
    const own = textOf(child);
    const attrs = [];
    if (child.tagName === 'INPUT') attrs.push(`type=${child.getAttribute('type') || 'text'}`, `value=${JSON.stringify(child.getAttribute('value') || '')}`);
    if (child.tagName === 'TEXTAREA') attrs.push(`value=${JSON.stringify(child.textContent || '')}`);
    if (child.hasAttribute('disabled')) attrs.push('disabled');
    if (child.hasAttribute('placeholder')) attrs.push(`placeholder=${JSON.stringify(child.getAttribute('placeholder'))}`);
    const marker = INTERACTIVE.has(child.tagName) ? ' *' : '';
    const label = `${'  '.repeat(depth)}<${child.tagName.toLowerCase()}${cls}${attrs.length ? ' ' + attrs.join(' ') : ''}>${marker}`;
    console.log(label + (own ? '  ' + own : ''));
    walk(child, depth + 1);
  }
}

console.log(`# UI dump — bridge ${base}`);
console.log(`# frames: ${frames.map((f) => f.type).join(', ') || 'none'}`);
console.log(`# app.js: ${PUBLIC}/app.js`);
console.log();
walk(app, 0);

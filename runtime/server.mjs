// Minimal HTTP+SSE bridge: web UI <-> pi-durable Harness (crash-safe, SQLite storage).
// Env: HOME (set by app), PI_PORT (default 0=ephemeral, port written to
// $HOME/.pi-mobile/port), PI_WORKDIR (agent cwd), PI_SHELL (bash path).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { copyFile, mkdir as mkdirP, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { watchEvents } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import {
  acquireOwnerLock, agentOf, createCredentialStore, createModelCatalog, ensureModel, isBusy,
  openHarness, pickModel, readJson, requestIdOf, sessionStore, Subagent, whenBusyOf,
  writeFileAtomic,
} from './common.mjs';
import { applySseBudget, writeSseChunk } from './sse.mjs';
import { createWatermark } from './watermark.mjs';
import { gateExtension, InstallGate } from './gate.mjs';
import { nodeBinaryOrNode } from './node-bin.mjs';

const ctx = BACKGROUND_CONTEXT;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.HOME || ROOT;
const WORKDIR = process.env.PI_WORKDIR || HOME_DIR;
const AGENT_DIR = path.join(HOME_DIR, '.pi', 'agent');
const AUTH_PATH = path.join(AGENT_DIR, 'auth.json');
const STATE_DIR = path.join(HOME_DIR, '.pi-mobile');
const PORT_FILE = path.join(STATE_DIR, 'port');
const TOKEN_FILE = path.join(STATE_DIR, 'token');
const LEGACY_SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const DEVICE_ID_FILE = path.join(STATE_DIR, 'device-id');
const PUBLIC = path.join(ROOT, 'public');
const { pathToFileURL } = await import('node:url');
const { estimateContext } = await import(
  pathToFileURL(path.join(ROOT, 'node_modules', '@earendil-works', 'pi-durable', 'dist', 'harness', 'compaction.js')).href
);
const MAX_BODY = 1024 * 1024;
// A client that has stopped reading, and how long it may stay stopped. A
// suspended WebView keeps its socket open and stops draining it, so without a
// bound the bridge buffers the conversation in this process -- on a phone.
//
// The bound is `budget + whatever the kernel socket buffer holds` (a few MB on
// Linux), because bytes the kernel accepted are not queued here yet and nothing
// in this process can see them. The stall window is what decides: a phone on a
// bad link still drains, so it is not dropped.
//
// The window is sampled, not watched: a write samples it, and the heartbeat
// samples it when nothing is being written, so a client that goes quiet is
// noticed within one heartbeat after the window has passed.
//
// The two knobs are a **test seam**, not a device setting: the Android host
// builds this process's environment itself (PiService) and does not pass these,
// so on the phone the defaults are the policy.
//
// Parsed rather than `Number(env) || fallback`, which turns "0" into the
// default and accepts "-5": a typo must not silently disable the bound, and a
// window of 0 has no room to see progress -- a client can then never finish
// receiving a snapshot larger than the budget, and reconnects into the same
// one. Hence `min` of 1 for both.
const envNumber = (name, fallback, min = 1) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= min) return value;
  // Silently falling back is how a typo looks configured and does nothing.
  console.error(`sse: ${name}=${JSON.stringify(raw)} is not a number >= ${min}; using ${fallback}`);
  return fallback;
};
const SSE_HEARTBEAT_MS = 20_000;
const SSE_MAX_BUFFERED_BYTES = envNumber('PI_SSE_MAX_BUFFERED', 1024 * 1024);
const SSE_STALL_MS = envNumber('PI_SSE_STALL_MS', SSE_HEARTBEAT_MS);
const watermark = createWatermark();
// The counter above starts at zero with the process; the client's stored watermark
// outlives the process. The epoch is how a client tells one run's numbers from the
// last one's, instead of comparing them.
const EPOCH = crypto.randomBytes(6).toString('hex');
const PI_PKG = '@earendil-works/pi-durable';
// The packages this runtime actually runs. The pi CLI, the pi-server host and
// the pi-client tunnel are gone from the app, so they are no longer updated.
const EARENDIL_PKGS = ['@earendil-works/pi-durable', '@earendil-works/pi-ai', '@earendil-works/chord'];
function piInstalledVersion() {
  try { return JSON.parse(readFileSync(path.join(ROOT,'node_modules',PI_PKG,'package.json'),'utf8')).version; } catch { return null; }
}
const piUpdate = { running: false, done: false, ok: false, changed: false, version: null, error: null, log: [] };
function startPiUpdate() {
  if (piUpdate.running) return { started: false, reason: 'an update is already running' };
  const before = piInstalledVersion();
  Object.assign(piUpdate, { running: true, done: false, ok: false, changed: false, version: null, error: null, log: [] });
  const prefix = process.env.PREFIX || '';
  // Run npm via node to avoid Termux shebang incompatibility on Android.
  // Try: node <npm-cli.js>, fallback to direct npm binary.
  // Not process.execPath: on Android that is the dynamic linker, and the
  // linker cannot run npm-cli.js. See runtime/node-bin.mjs.
  const nodeBin = nodeBinaryOrNode();
  const npmCli = prefix ? `${prefix}/lib/node_modules/npm/bin/npm-cli.js` : null;
  let spawnArgs;
  if (npmCli && existsSync(npmCli)) {
    spawnArgs = [nodeBin, [npmCli, 'install']];
  } else {
    const npmBin = prefix ? `${prefix}/bin/npm` : 'npm';
    spawnArgs = [npmBin, ['install']];
  }
  const pkgs = EARENDIL_PKGS.map(p => `${p}@latest`);
  const child = spawn(spawnArgs[0], [...spawnArgs[1], ...pkgs, '--no-fund', '--no-audit', '--ignore-scripts', '--no-package-lock'], {
    cwd: ROOT, env: { ...process.env, npm_config_cache: path.join(HOME_DIR, '.npm') },
  });
  const addLog = (d) => { for (const l of String(d).split('\n')) { const t = l.trimEnd(); if (t) { piUpdate.log.push(t); if (piUpdate.log.length > 500) piUpdate.log.shift(); } } };
  child.stdout.on('data', addLog); child.stderr.on('data', addLog);
  child.on('close', (code) => {
    const after = piInstalledVersion();
    piUpdate.running = false; piUpdate.done = true;
    piUpdate.ok = code === 0; piUpdate.version = after;
    // Restarting reloads the modules, so it is only worth interrupting the
    // bridge for when the version actually moved. `@latest` resolving to what is
    // already installed used to exit the process anyway: from the user's side
    // that is a dropped connection and no explanation.
    piUpdate.changed = code === 0 && after !== before;
    piUpdate.error = code !== 0 ? `npm exited with code ${code}` : null;
    if (code === 0) {
      addLog(piUpdate.changed
        ? `pi ${before ?? '?'} → ${after} — restarting the bridge…`
        : `pi ${after ?? '?'} is already the latest — nothing to restart`);
      if (piUpdate.changed) setTimeout(() => process.exit(0), 1500);
    }
  });
  child.on('error', (e) => { piUpdate.running = false; piUpdate.done = true; piUpdate.ok = false; piUpdate.error = e.message; });
  return { started: true, from: before };
}

// --- backups -------------------------------------------------------------------------
// The one thing a phone cannot recover: the sessions and the API keys in $HOME,
// which a reinstall deletes without asking. The archive lands inside the tree the
// user already pulls off the device (adb pull / scp / git), and the UI says where.
const BACKUP_DIR = path.join(STATE_DIR, 'backups');
const KEEP_BACKUPS = 10;
const backupState = { running: false, error: null };

/** Run a program and wait for it, collecting what it said. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, opts);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({ code: -1, out: e.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

/**
 * One archive: a consistent copy of the database plus the credentials.
 *
 * The database is copied with SQLite's own backup rather than `copyFile`: the
 * bridge is writing to it, and a copy of a file mid-write restores into a broken
 * app. `copyFile` is the fallback, and the manifest records which one was used.
 */
async function makeBackup() {
  if (backupState.running) return { started: false, reason: 'a backup is already running' };
  backupState.running = true;
  backupState.error = null;
  const staging = await mkdtemp(path.join(os.tmpdir(), 'pi-backup-'));
  try {
    const db = path.join(STATE_DIR, 'harness.sqlite');
    const copied = path.join(staging, 'harness.sqlite');
    const sqlite = process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', 'sqlite3') : 'sqlite3';
    const res = await run(sqlite, [db, `.backup '${copied}'`]);
    if (res.code !== 0 || !existsSync(copied)) {
      await copyFile(db, copied);
      backupState.error = `sqlite3 backup failed (${res.out.trim() || res.code}); copied the file instead`;
    }
    // Credentials and model choices: small, and missed the moment they are gone.
    for (const rel of [path.join('.pi', 'agent', 'auth.json'), path.join('.pi', 'agent', 'models.json')]) {
      const from = path.join(HOME_DIR, rel);
      if (!existsSync(from)) continue;
      await mkdirP(path.dirname(path.join(staging, rel)), { recursive: true });
      await copyFile(from, path.join(staging, rel));
    }
    const at = new Date().toISOString();
    await writeFile(path.join(staging, 'backup.json'), JSON.stringify({
      at, app: 'pi-mobile', dbBytes: (await stat(copied)).size,
      database: backupState.error ?? 'sqlite3 .backup',
    }, null, 2));
    await mkdirP(BACKUP_DIR, { recursive: true });
    const name = `pi-backup-${at.replace(/[:.]/g, '-').slice(0, 19)}.tar.gz`;
    const target = path.join(BACKUP_DIR, name);
    const tar = await run('tar', ['-czf', target, '-C', staging, '.']);
    if (tar.code !== 0) throw new Error(`tar failed: ${tar.out.trim() || tar.code}`);
    await pruneBackups();
    return { started: true, name, path: target, at, bytes: (await stat(target)).size, warning: backupState.error ?? undefined };
  } finally {
    backupState.running = false;
    await rm(staging, { recursive: true, force: true });
  }
}

async function pruneBackups() {
  try {
    const names = (await readdir(BACKUP_DIR)).filter((n) => n.startsWith('pi-backup-') && n.endsWith('.tar.gz')).sort();
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) {
      await rm(path.join(BACKUP_DIR, name), { force: true });
    }
  } catch {}
}

async function listBackups() {
  try {
    const names = (await readdir(BACKUP_DIR)).filter((n) => n.startsWith('pi-backup-') && n.endsWith('.tar.gz')).sort().reverse();
    return await Promise.all(names.map(async (name) => {
      const st = await stat(path.join(BACKUP_DIR, name));
      return { name, bytes: st.size, at: st.mtime.toISOString(), path: path.join(BACKUP_DIR, name) };
    }));
  } catch { return []; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

await mkdir(STATE_DIR, { recursive: true });
// pi-durable allows one storage owner: stop an orphaned predecessor first
const releaseLock = await acquireOwnerLock(path.join(STATE_DIR, 'server.lock'), 'server.mjs');

// --- credentials / models ---------------------------------------------------------

const credentialStore = createCredentialStore(AUTH_PATH);
const models = await createModelCatalog(credentialStore);

// --- execution environment ---------------------------------------------------------

function envFor({ cwd } = {}) {
  const dir = cwd ?? WORKDIR;
  const prefix = process.env.PREFIX;
  const bash = prefix && existsSync(path.join(prefix, 'bin/bash'))
    ? path.join(prefix, 'bin/bash') : undefined;
  const shellEnv = prefix
    ? { ...process.env, PATH: `${prefix}/bin:/system/bin:${process.env.PATH || ''}` }
    : undefined;
  return new NodeExecutionEnv({ cwd: dir, shellPath: process.env.PI_SHELL || bash, shellEnv });
}

// --- OAuth ---------------------------------------------------------------------------

const oauthLogins = new Map();
function deviceId() {
  try { return readFileSync(DEVICE_ID_FILE, 'utf8').trim(); } catch {}
  const id = crypto.randomUUID();
  writeFileAtomic(DEVICE_ID_FILE, id);
  return id;
}
function startOAuthLogin(providerId) {
  const provider = models.getProvider(providerId);
  if (!provider?.auth.oauth) throw new Error(`${providerId} does not support OAuth login`);
  const id = crypto.randomUUID();
  const login = { id, events: [], prompt: null, done: false, error: null, credential: null };
  oauthLogins.set(id, login);
  const interaction = {
    signal: new AbortController().signal,
    notify: (event) => login.events.push(event),
    prompt: (prompt) => new Promise((resolve, reject) => {
      login.prompt = { id: crypto.randomUUID(), prompt, resolve, reject };
    }),
  };
  models.login(providerId, 'oauth', interaction, { getDeviceId: deviceId })
    .then(async (credential) => {
      login.credential = credential;
      login.done = true;
      try { await models.refresh({ providers: [providerId] }); } catch {}
      await giveActiveSessionAModel();
    })
    .catch((error) => { login.error = String(error?.message || error); login.done = true; })
    .finally(() => setTimeout(() => oauthLogins.delete(id), 10 * 60_000).unref());
  return login;
}

// --- harness + durable session registry ---------------------------------------------

const { harness, registry } = await openHarness({ dbPath: path.join(STATE_DIR, 'harness.sqlite'), models, env: envFor, extensions: [Subagent] }, ctx);

// The install gate. The agent writes an extension into the workspace and
// proposes it; the user is shown the file, its hash and its diff, and taps
// Install. Only then does it run — inside this process, which is what the
// plan means by "an agent-written extension is kernel code".
const gate = new InstallGate({
  dir: path.join(WORKDIR, 'extensions'),
  stateFile: path.join(STATE_DIR, 'extensions.json'),
  registry,
  // A proposal, an install, a refusal: the client is told, so the sheet is
  // never stale and the menu can say that something is waiting.
  onChange: () => notifyExtensions(),
});
await mkdir(gate.dir, { recursive: true });
registry.install(gateExtension(gate));
// Whatever was installed before the bridge restarted goes back in. A file that
// changed since it was approved does not: the user approved a hash.
for (const restored of await gate.restore()) {
  if (!restored.ok) console.error(`extension ${restored.key} was not restored: ${restored.error}`);
}
const sessions = sessionStore(harness, ctx);
let active = null; // the conversation the chat page shows

async function initHarness() {
  const root = await harness.root(ctx, { agent: { model: await pickModel(models) } });
  // one-time import of the old JSON side file
  const legacy = readJson(LEGACY_SESSIONS_FILE, null)?.sessions;
  if (legacy && Object.keys(legacy).length) {
    await sessions.migrate(legacy);
    writeFileAtomic(`${LEGACY_SESSIONS_FILE}.migrated`, JSON.stringify({ sessions: legacy }, null, 2));
    try { unlinkSync(LEGACY_SESSIONS_FILE); } catch {}
  }
  await sessions.register(root.id, { name: 'Main' });
  // reopen the session that was active before the restart
  const remembered = await sessions.activeId();
  const conv = (remembered && (await sessions.get(remembered)) && await harness.conversation(Number(remembered), ctx)) || root;
  await activate(conv, { persist: false });
  await ensureModel(active, models, ctx);
  harness.resume(); // continue runs the last process left unfinished
}

async function activate(conversation, { persist = true } = {}) {
  active = conversation;
  if (persist) await sessions.setActive(conversation.id);
  for (const client of sseClients) await attachSse(client);
}

async function currentModel(conv) {
  const view = await conv.viewState(ctx);
  try { return agentOf(view).model; } finally { view.dispose?.(); }
}

async function giveActiveSessionAModel() {
  if (active) { try { await ensureModel(active, models, ctx); } catch {} }
}

// --- SSE: one watchEvents stream per client -------------------------------------------
// A stream's snapshot is the state at attach time; giving every (re)connecting
// client its own stream delivers the current state plus deltas (late join).
//
// The kernel already bounds its own delivery -- watchEvents replaces undelivered
// batches with one snapshot on overflow -- so nothing here needs a watermark to
// stay *correct*. What the kernel cannot see is the socket: `res.write` queues
// into this process when the client stops reading, and that queue is unbounded
// unless it is bounded here. So a stalled client is dropped instead, and the
// reconnect it makes is what repairs it: a fresh stream, a fresh snapshot, and
// no gap for anyone to reason about.

const sseClients = new Set();

/**
 * Take one look at a client's queue, and drop it if it has stopped draining.
 * Called after every write and on every heartbeat: a client can stop reading at
 * any moment, and nothing else would notice.
 */
function sampleSseBudget(client) {
  if (client.closed) return;
  applySseBudget(client, {
    now: Date.now(), maxBufferedBytes: SSE_MAX_BUFFERED_BYTES, stallMs: SSE_STALL_MS,
    // Dropping stops a kernel stream, so it is async; a floating promise here
    // would be an unhandled rejection waiting to happen.
    drop: (c, bufferedBytes) => void dropSseClient(c, bufferedBytes),
  });
}

/**
 * Drop a client that is not reading.
 *
 * `destroy` rather than `end`: the point of dropping it is to free the queue,
 * and `end` keeps every queued byte in memory until the peer resumes and reads
 * it -- which for a suspended WebView may be minutes, or never. There is
 * nothing to lose on the way out: the client gets a snapshot when it comes
 * back.
 */
async function dropSseClient(client, bufferedBytes) {
  if (client.closed) return;
  client.closed = true;
  sseClients.delete(client);
  const stream = client.stream;
  client.stream = null;
  // Free the queue before anything else: releasing those bytes is the whole
  // point, and stopping the kernel stream can take a moment.
  try { client.res.destroy(); } catch {}
  if (stream) { try { await stream.stop(); } catch {} }
  console.error(`sse: dropped a client that stopped reading (${bufferedBytes} bytes queued, over ${SSE_MAX_BUFFERED_BYTES} for ${SSE_STALL_MS}ms); it reconnects for a snapshot`);
}

function sseWrite(client, event) {
  // Idempotent: a frame written to several clients keeps the number it was given
  // the first time.
  watermark.stamp(event);
  const text = `data: ${JSON.stringify(event)}\n\n`;
  if (!writeSseChunk(client, text, { drop: (c, bytes) => void dropSseClient(c, bytes) })) return;
  sampleSseBudget(client);
}

/** Tell the clients that the proposals changed, so the sheet can update. */
function notifyExtensions() {
  for (const client of sseClients) sseWrite(client, { type: 'bridge_extensions' });
}

async function attachSse(client) {
  const previous = client.stream;
  client.stream = null;
  if (previous) { try { await previous.stop(); } catch {} }
  if (!active || client.closed) return;
  const conversationId = active.id;
  const stream = await watchEvents(harness, conversationId, ctx);
  if (client.closed) { await stream.stop(); return; }
  client.stream = stream;
  const meta = await sessions.get(conversationId);
  let contextTokens = 0;
  try { const cview = await active.context(ctx); contextTokens = estimateContext(cview, []) || 0; } catch {}
  const _view = active ? await active.viewState(ctx) : null;
  const modelRef = _view ? agentOf(_view).model : null;
  try { _view?.dispose?.(); } catch {}
  const contextWindow = modelByRef(modelRef)?.contextWindow ?? 128000;
  // Where the counter stood when this client CONNECTED, not where it stands now:
  // a frame written since then was written for somebody else, or for this client
  // after it had already attached. A re-attach is a session switch, not a
  // reconnect -- the client never stopped receiving -- so it reports no gap.
  const gapped = !client.attached && watermark.gapped(client.since, client.base);
  client.attached = true;
  sseWrite(client, {
    type: 'bridge_snapshot', snapshot: stream.snapshot,
    sessionId: String(conversationId), sessionName: meta?.name ?? `Session ${conversationId}`,
    contextTokens,
    contextWindow,
    gapped,
  });
  // The snapshot write above can have dropped this client already -- it is the
  // largest frame we send, so it is the likeliest one to go over the budget.
  // Starting a watch that was stopped with it throws, and the route's catch
  // would swallow that into a no-op write to a closed response.
  if (client.closed) { try { await stream.stop(); } catch {} return; }
  stream.start(async (events) => {
    if (client.stream !== stream) return;
    for (const e of events) sseWrite(client, e);
  });
}

setInterval(() => {
  for (const client of sseClients) {
    // Counted like any other write, so a client draining a snapshot that
    // finished long ago still shows progress.
    if (!writeSseChunk(client, ': ping\n\n', { drop: (c, bytes) => void dropSseClient(c, bytes) })) continue;
    // The heartbeat is the only thing that runs when nothing is being written,
    // so it is where a silent client gets noticed.
    sampleSseBudget(client);
  }
}, SSE_HEARTBEAT_MS).unref();

// --- HTTP helpers -------------------------------------------------------------------

const token = existsSync(TOKEN_FILE)
  ? (await readFile(TOKEN_FILE, 'utf8')).trim()
  : await (async () => {
      const t = crypto.randomBytes(24).toString('base64url');
      await writeFile(TOKEN_FILE, t, { mode: 0o600 });
      return t;
    })();
const tokenBuf = Buffer.from(token);

function authed(req) {
  const url = new URL(req.url, 'http://localhost');
  const given = String(req.headers['x-token'] || url.searchParams.get('token') || '');
  const buf = Buffer.from(given);
  return buf.length === tokenBuf.length && crypto.timingSafeEqual(buf, tokenBuf);
}
let listenPort = 0;
// DNS-rebinding guard: only the loopback names the WebView uses
function hostAllowed(req) {
  const h = String(req.headers.host || '');
  return h === `127.0.0.1:${listenPort}` || h === `localhost:${listenPort}`;
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}
const str = (v, max = 200) => String(v ?? '').slice(0, max);

function serveStatic(res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch { res.writeHead(400); return res.end(); }
  let filePath = path.resolve(PUBLIC, `.${rel}`);
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  let st = null;
  try { st = statSync(filePath); } catch {}
  if (!st?.isFile()) { filePath = path.join(PUBLIC, 'index.html'); }
  // `no-store` covers the response, not what the WebView already compiled: a
  // reload that reuses a cached page can keep running the module it fetched
  // before the file was edited, which is invisible until an edit appears not to
  // have landed. Naming the assets by their mtime makes every edit a URL the
  // WebView has never seen, so a stale copy cannot shadow a fresh one.
  if (path.basename(filePath) === 'index.html') {
    let html;
    try { html = readFileSync(filePath, 'utf8'); } catch { res.writeHead(500); return res.end(); }
    const version = (name) => {
      try { return Math.trunc(statSync(path.join(PUBLIC, name)).mtimeMs).toString(36); } catch { return '0'; }
    };
    // An existing query is replaced, not appended to: a hand-versioned page (the
    // deploy path for a runtime older than this code) must not freeze a stale
    // version forever.
    html = html.replace(/(href|src)="(style\.css|app\.js)(\?[^"]*)?"/g, (_, attr, name) => `${attr}="${name}?v=${version(name)}"`);
    res.writeHead(200, {
      'content-type': MIME['.html'],
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(html),
    });
    return res.end(html);
  }
  // No caching: the whole point of the no-build client is that the file the agent edits on the
  // phone is the file that runs, and that only works if a reload really re-fetches it.
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  const stream = createReadStream(filePath);
  stream.on('error', () => { try { res.destroy(); } catch {} });
  stream.pipe(res);
}

// --- API -----------------------------------------------------------------------------

/** The thinking levels a model accepts, always including "off". */
function thinkingLevelsOf(model) {
  if (!model) return ['off'];
  try {
    const levels = getSupportedThinkingLevels(model);
    return levels?.length ? levels : ['off'];
  } catch {
    return ['off'];
  }
}

/** The model object behind a { provider, modelId } reference, if it is known. */
function modelByRef(ref) {
  if (!ref?.provider || !ref?.modelId) return undefined;
  try { return models.getModel(ref.provider, ref.modelId); } catch { return undefined; }
}

async function activeState() {
  const view = active ? await active.viewState(ctx) : null;
  try {
    const meta = active ? await sessions.get(active.id) : null;
    const modelRef = agentOf(view).model ?? null;
    const modelObj = modelRef ? { ...modelRef, contextWindow: modelByRef(modelRef)?.contextWindow ?? 128000 } : null;
    // Current context size (tokens) for the active conversation, via the kernel's estimator.
    let contextTokens = 0;
    if (active) {
      try {
        const cview = await active.context(ctx);
        contextTokens = estimateContext(cview, []) || 0;
      } catch {}
    }
    return {
      model: modelObj,
      thinkingLevel: agentOf(view).thinkingLevel ?? 'off',
      busy: isBusy(view),
      inbox: view?.value?.docs?.['pi.inbox'] ?? null,
      usage: view?.value?.docs?.['pi.usage'] ?? null,
      contextTokens,
      cwd: agentOf(view).cwd ?? WORKDIR,
      sessionId: active ? String(active.id) : null,
      sessionName: meta?.name ?? 'Main',
    };
  } finally { view?.dispose?.(); }
}

async function handleApi(req, res, url, p) {
  const body = req.method === 'POST' ? await readBody(req) : {};
  if (!active && !p.startsWith('/api/oauth') && p !== '/api/auth' && p !== '/api/providers') {
    throw Object.assign(new Error('harness not ready'), { status: 503 });
  }

  if (p === '/api/pi-update' && req.method === 'GET') {
    // `installed` is read from disk every time: it is the answer to "what am I
    // running", and the update is the one thing that changes it.
    return json(res, 200, { ...piUpdate, installed: piInstalledVersion() });
  }
  if (p === '/api/pi-update' && req.method === 'POST') {
    return json(res, 200, startPiUpdate());
  }
  if (p === '/api/state') return json(res, 200, await activeState());

  // --- local sessions
  if (p === '/api/sessions' && req.method === 'GET') {
    return json(res, 200, { activeId: active ? String(active.id) : null, sessions: await sessions.list() });
  }
  if (p === '/api/sessions/new' && req.method === 'POST') {
    // a new session starts with the model the current one uses
    const conversation = await sessions.create(
      { name: str(body.name, 100) || undefined },
      { agent: { model: (await currentModel(active)) ?? await pickModel(models) } },
    );
    await activate(conversation);
    return json(res, 200, { ok: true, activeId: String(conversation.id) });
  }
  if (p === '/api/sessions/select' && req.method === 'POST') {
    const id = str(body.id);
    if (!(await sessions.get(id))) return json(res, 404, { error: 'unknown session' });
    const conversation = await harness.conversation(Number(id), ctx);
    if (!conversation) return json(res, 404, { error: 'session unavailable' });
    await activate(conversation);
    return json(res, 200, { ok: true, activeId: String(conversation.id) });
  }
  if (p === '/api/sessions/rename' && req.method === 'POST') {
    const id = str(body.id);
    if (!(await sessions.get(id))) return json(res, 404, { error: 'unknown session' });
    await sessions.rename(id, body.name);
    return json(res, 200, { ok: true, id: String(id), name: str(body.name, 100).trim() || null });
  }
  if (p === '/api/sessions/archive' && req.method === 'POST') {
    const id = str(body.id);
    if (!(await sessions.get(id))) return json(res, 404, { error: 'unknown session' });
    // Only archiving is refused while it is open -- bringing one back must work
    // even though opening it made it the active one.
    if (body.archived !== false && String(active?.id) === String(id)) {
      return json(res, 400, { error: 'cannot archive the session that is open' });
    }
    await sessions.setArchived(id, body.archived !== false);
    return json(res, 200, { ok: true, id: String(id), archived: body.archived !== false });
  }
  if (p === '/api/backup' && req.method === 'GET') {
    return json(res, 200, { dir: BACKUP_DIR, backups: await listBackups(), running: backupState.running, error: backupState.error });
  }
  if (p === '/api/backup' && req.method === 'POST') {
    try {
      return json(res, 200, await makeBackup());
    } catch (e) {
      return json(res, 500, { started: false, error: String(e?.message || e) });
    }
  }

  // --- the install gate
  if (p === '/api/extensions' && req.method === 'GET') {
    return json(res, 200, {
      installed: gate.installed(),
      proposals: gate.proposals(),
      // The proposals that could not be installed, and why: the sheet must not
      // say "installed" for something the kernel does not have.
      problems: gate.problems(),
    });
  }
  if (p === '/api/extensions/install' && req.method === 'POST') {
    // The hash is the one the user was shown. A file that changed since is
    // refused: the user approved a file, not a name.
    const result = await gate.install(str(body.key), str(body.hash) || undefined);
    return json(res, 200, { ok: true, ...result });
  }
  if (p === '/api/extensions/reject' && req.method === 'POST') {
    const result = gate.reject(str(body.key), str(body.hash) || undefined);
    return json(res, 200, { ok: true, ...result });
  }
  if (p === '/api/extensions/uninstall' && req.method === 'POST') {
    const result = gate.uninstall(str(body.key));
    return json(res, 200, { ok: true, ...result });
  }

  // --- active conversation
  if (p === '/api/prompt' && req.method === 'POST') {
    if (!(await ensureModel(active, models, ctx))) return json(res, 400, { error: 'no model: set an API key first' });
    const sub = await active.submit({
      type: 'input',
      content: String(body.message || ''),
      requestId: requestIdOf(body.requestId), // exactly-once across client retries
      whenBusy: whenBusyOf(body.whenBusy),
    }, ctx);
    return json(res, 200, { ok: true, submissionId: sub.id });
  }
  if (p === '/api/abort' && req.method === 'POST') {
    await active.abort(ctx);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/new' && req.method === 'POST') {
    await active.reset(typeof body.note === 'string' ? body.note : undefined, ctx);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/compact' && req.method === 'POST') {
    const taskId = await active.compact(typeof body.instructions === 'string' ? body.instructions : undefined, ctx);
    return json(res, 200, { ok: true, taskId });
  }
  if (p === '/api/usage' && req.method === 'GET') {
    return json(res, 200, { session: (await activeState()).usage, total: await harness.usage(ctx) });
  }
  if (p === '/api/models' && req.method === 'GET') {
    const avail = await models.getAvailable();
    return json(res, 200, {
      models: avail.map((m) => ({
        provider: m.provider,
        modelId: m.id,
        name: m.name ?? m.id,
        thinkingLevels: thinkingLevelsOf(m),
        contextWindow: m.contextWindow ?? 128000,
      })),
    });
  }
  // The thinking level, and the levels the current model actually supports:
  // a model that takes no reasoning effort offers none, and one that does
  // offers a subset.
  if (p === '/api/thinking' && req.method === 'GET') {
    const view = active ? await active.viewState(ctx) : null;
    try {
      const agent = agentOf(view);
      const model = modelByRef(agent.model);
      return json(res, 200, {
        level: agent.thinkingLevel ?? 'off',
        // "off" is always offered: a provider can map "off" to null and leave it out of its
        // supported list, and then the user would have no way to turn thinking off.
        supported: model ? Array.from(new Set(['off', ...thinkingLevelsOf(model)])) : ['off'],
      });
    } finally { view?.dispose?.(); }
  }
  if (p === '/api/thinking' && req.method === 'POST') {
    const level = str(body.level);
    const view = active ? await active.viewState(ctx) : null;
    try {
      const model = modelByRef(agentOf(view).model);
      const supported = model ? Array.from(new Set(['off', ...thinkingLevelsOf(model)])) : ['off'];
      // Refuse a level the model cannot take, rather than storing it and
      // letting the provider reject it at the next call.
      if (!supported.includes(level)) {
        return json(res, 400, { error: `this model takes ${supported.join(', ')}` });
      }
      await active.configure({ thinkingLevel: level }, ctx);
      return json(res, 200, { ok: true, level });
    } finally { view?.dispose?.(); }
  }
  if (p === '/api/model' && req.method === 'POST') {
    if (!body.provider || !body.modelId) return json(res, 400, { error: 'provider+modelId required' });
    await active.configure({ model: { provider: str(body.provider), modelId: str(body.modelId) } }, ctx);
    const view = await active.viewState(ctx);
    try { return json(res, 200, { ok: true, applied: agentOf(view).model }); } finally { view.dispose?.(); }
  }

  // --- accounts
  if (p === '/api/oauth/providers' && req.method === 'GET') {
    return json(res, 200, { providers: models.getProviders()
      .filter((provider) => Boolean(provider.auth.oauth))
      .map((provider) => ({ id: provider.id, name: provider.name, label: provider.auth.oauth?.loginLabel || provider.auth.oauth?.name })) });
  }
  if (p === '/api/oauth/start' && req.method === 'POST') {
    const login = startOAuthLogin(str(body.provider));
    return json(res, 200, { id: login.id });
  }
  if (p === '/api/oauth/status' && req.method === 'GET') {
    const login = oauthLogins.get(url.searchParams.get('id'));
    if (!login) return json(res, 404, { error: 'unknown login' });
    const prompt = login.prompt?.prompt;
    return json(res, 200, {
      events: login.events.splice(0), done: login.done, error: login.error,
      prompt: prompt ? { id: login.prompt.id, type: prompt.type, message: prompt.message,
        placeholder: prompt.placeholder, options: prompt.options } : null,
    });
  }
  if (p === '/api/oauth/respond' && req.method === 'POST') {
    const login = oauthLogins.get(str(body.id));
    if (!login?.prompt || login.prompt.id !== body.promptId) return json(res, 400, { error: 'no matching prompt' });
    const pending = login.prompt;
    login.prompt = null;
    pending.resolve(String(body.value ?? ''));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/auth' && req.method === 'POST') {
    if (!body.provider) return json(res, 400, { error: 'provider required' });
    const provider = str(body.provider);
    if (body.delete) {
      await credentialStore.delete(provider);
      return json(res, 200, { ok: true });
    }
    if (!body.key) return json(res, 400, { error: 'key required' });
    await credentialStore.modify(provider, async () => ({ type: 'api_key', key: String(body.key) }));
    try { await models.refresh(); } catch {}
    await giveActiveSessionAModel();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/providers' && req.method === 'GET') {
    return json(res, 200, {
      // The keys that are already set.
      providers: Object.entries(credentialStore.readAll()).map(([provider, c]) => ({
        provider,
        type: c?.type ?? 'api_key',
        keyHint: c?.key ? `…${String(c.key).slice(-4)}` : null,
      })),
      // Every provider that would take an API key, so the client can offer a
      // picker instead of making the user type a provider id.
      catalog: models.getProviders()
        .filter((provider) => Boolean(provider.auth?.apiKey))
        .map((provider) => ({ id: provider.id, name: provider.name })),
    });
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req)) { res.writeHead(421); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/events' && req.method === 'GET') {
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // `base` below is taken before the connect frame is stamped, so that frame is
    // not itself counted as a frame the client missed.
    const client = {
      res, stream: null, closed: false, overSince: null, lastFlushedBytes: null, sseBytesWritten: 0,
      // The watermark the client claims to have seen, and where the counter stood
      // when it connected. The pair is only read by the first attach: a later one
      // is a session switch, not a reconnect.
      since: url.searchParams.get('since'),
      base: watermark.current(),
      attached: false,
    };
    res.write(`data: ${JSON.stringify(watermark.stamp({ type: 'bridge_connected', epoch: EPOCH }))}\n\n`);
    sseClients.add(client);
    req.on('close', async () => {
      client.closed = true;
      sseClients.delete(client);
      try { await client.stream?.stop(); } catch {}
    });
    try { await attachSse(client); } catch (e) { sseWrite(client, { type: 'bridge_error', error: String(e?.message || e) }); }
    return;
  }

  if (p.startsWith('/api/')) {
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      return await handleApi(req, res, url, p);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch {} return; }
      const httpCode = (Number.isInteger(e?.status) && e.status >= 100 && e.status <= 599) ? e.status : 500;
      return json(res, httpCode, { error: String(e?.message || e), reconnecting: e?.reconnecting || undefined });
    }
  }

  return serveStatic(res, p);
});

// --- start / stop ------------------------------------------------------------

await mkdir(WORKDIR, { recursive: true });
try {
  await initHarness();
} catch (e) {
  // a bridge without a harness is useless: exit so PiService restarts it with backoff
  console.error('initHarness:', e?.stack || e);
  try { await harness.close(ctx); } catch {}
  releaseLock();
  process.exit(1);
}
// A stable port, not an ephemeral one. The WebView's URL is the origin, and
// its modules, its EventSource and its localStorage all live under it: a bridge
// that comes back on a new port leaves the page retrying a socket that is gone
// for good, with no way to learn the new one (only the Android host knows, and
// it only reloads the page when a `loadUrl` fails). Reusing the port means a
// restart is just a reconnect.
const PORT_CANDIDATES = process.env.PI_PORT
  ? [Number(process.env.PI_PORT)]
  : [8787, 8788, 8789, 8790, 8791, 0];
async function listenOnFirstFreePort() {
  for (const port of PORT_CANDIDATES) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (e) => { server.off('listening', onListening); reject(e); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return true;
    } catch (e) {
      if (e?.code !== 'EADDRINUSE' && e?.code !== 'EACCES') throw e;
      console.error(`bridge: port ${port} is taken (${e.code}); trying the next one`);
    }
  }
  return false;
}
if (!(await listenOnFirstFreePort())) {
  console.error('bridge: no port available');
  releaseLock();
  process.exit(1);
}
listenPort = server.address().port;
writeFileAtomic(PORT_FILE, String(listenPort), 0o600);
console.log(`pi-mobile durable bridge on 127.0.0.1:${listenPort}`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`bridge: ${signal}, closing`);
  try { unlinkSync(PORT_FILE); } catch {}
  server.close();
  for (const client of sseClients) { try { await client.stream?.stop(); client.res.end(); } catch {} }
  try { await harness.close(ctx); } catch (e) { console.error('harness.close:', e?.message || e); }
  releaseLock();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

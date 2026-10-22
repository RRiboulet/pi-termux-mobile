// Minimal HTTP+SSE bridge: web UI <-> pi-durable Harness (crash-safe, SQLite storage).
// Env: HOME (set by app), PI_PORT (default 0=ephemeral, port written to
// $HOME/.pi-mobile/port), PI_WORKDIR (agent cwd), PI_SHELL (bash path).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
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
const MAX_BODY = 1024 * 1024;
const PI_PKG = '@earendil-works/pi-durable';
// The packages this runtime actually runs. The pi CLI, the pi-server host and
// the pi-client tunnel are gone from the app, so they are no longer updated.
const EARENDIL_PKGS = ['@earendil-works/pi-durable', '@earendil-works/pi-ai', '@earendil-works/chord'];
function piInstalledVersion() {
  try { return JSON.parse(readFileSync(path.join(ROOT,'node_modules',PI_PKG,'package.json'),'utf8')).version; } catch { return null; }
}
const piUpdate = { running: false, done: false, ok: false, version: null, error: null, log: [] };
function startPiUpdate() {
  if (piUpdate.running) return false;
  Object.assign(piUpdate, { running: true, done: false, ok: false, version: null, error: null, log: [] });
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
    piUpdate.running = false; piUpdate.done = true;
    piUpdate.ok = code === 0; piUpdate.version = piInstalledVersion();
    piUpdate.error = code !== 0 ? `npm exited with code ${code}` : null;
    if (code === 0) { addLog(`pi updated to ${piUpdate.version} — restarting bridge…`); setTimeout(() => process.exit(0), 1500); }
  });
  child.on('error', (e) => { piUpdate.running = false; piUpdate.done = true; piUpdate.ok = false; piUpdate.error = e.message; });
  return true;
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

const sseClients = new Set();

function sseWrite(client, event) {
  try { client.res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
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
  sseWrite(client, {
    type: 'bridge_snapshot', snapshot: stream.snapshot,
    sessionId: String(conversationId), sessionName: meta?.name ?? `Session ${conversationId}`,
  });
  stream.start(async (events) => {
    if (client.stream !== stream) return;
    for (const e of events) sseWrite(client, e);
  });
}

setInterval(() => {
  for (const client of sseClients) { try { client.res.write(': ping\n\n'); } catch {} }
}, 20_000).unref();

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
    return {
      model: agentOf(view).model ?? null,
      thinkingLevel: agentOf(view).thinkingLevel ?? 'off',
      busy: isBusy(view),
      inbox: view?.value?.docs?.['pi.inbox'] ?? null,
      usage: view?.value?.docs?.['pi.usage'] ?? null,
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

  if (p === '/api/pi-update' && req.method === 'POST') {
    return json(res, 200, { started: startPiUpdate() });
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
    res.write(`data: ${JSON.stringify({ type: 'bridge_connected' })}\n\n`);
    const client = { res, stream: null, closed: false };
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
server.listen(Number(process.env.PI_PORT || 0), '127.0.0.1', async () => {
  listenPort = server.address().port;
  writeFileAtomic(PORT_FILE, String(listenPort), 0o600);
  console.log(`pi-mobile durable bridge on 127.0.0.1:${listenPort}`);
});

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

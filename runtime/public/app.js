// pi — a mobile agent client for the Pi Durable bridge.
//
// One screen. The conversation, a status line, a composer. Sessions, models
// and usage are sheets.
//
// No build step: Preact and htm are vendored under ./vendor, so the file the
// agent edits on the phone is the file that runs. The kernel's API is the
// contract; see runtime/server.mjs.

import { render, h } from './vendor/preact.js';
import htm from './vendor/htm.js';

// htm's ESM build exports only the default function; Preact's own `h` is the
// createElement that htm.bind wants.
const html = htm.bind(h);

// ── token ────────────────────────────────────────────────────────────────
// The Activity loads /?token=...; keep it in localStorage and take it out of
// the address bar, so it is not left in a screenshot or a history entry.
const params = new URLSearchParams(location.search);
let token = params.get('token') || localStorage.getItem('pi-token') || '';
if (token) {
  localStorage.setItem('pi-token', token);
  if (params.get('token')) {
    params.delete('token');
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : ''));
  }
}

// ── api ──────────────────────────────────────────────────────────────────
const headers = () => ({ 'content-type': 'application/json', 'x-token': token });

async function get(path) {
  const r = await fetch(path, { headers: { 'x-token': token } });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}

/**
 * POST, with the retry the old client had: a phone loses the bridge for a moment all the time, and
 * the body carries a requestId, so a retried prompt is answered once and only once.
 */
async function post(path, body, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body ?? {}) });
      const j = await r.json().catch(() => ({ error: `http ${r.status}` }));
      // 503 with "reconnecting" is the bridge restarting; the same body is safe to send again.
      if (r.status === 503 && j.reconnecting && attempt < retries) {
        await new Promise((res) => setTimeout(res, 1500));
        continue;
      }
      if (!r.ok) throw new Error(j.error || `http ${r.status}`);
      return j;
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
  }
}

const requestId = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

// ── text helpers ─────────────────────────────────────────────────────────
function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
}

// A very small markdown: fenced code, inline code, paragraphs. Enough to
// make a transcript readable, and nothing that can execute anything.
function markdown(src) {
  const out = [];
  // The split ALTERNATES: even indices are prose, odd ones are code. Treating every index
  // after the first as code turned the prose after a fence into a code block.
  const blocks = String(src ?? '').split(/```/);
  blocks.forEach((block, i) => {
    if (i % 2 === 0) { out.push(...paragraphs(block)); return; }
    const nl = block.indexOf('\n');
    const lang = nl === -1 ? '' : block.slice(0, nl).trim();
    const body = nl === -1 ? '' : block.slice(nl + 1);
    out.push(html`<div class="fence">${lang || 'code'}</div>`, html`<pre><code>${body.replace(/\n$/, '')}</code></pre>`);
  });
  return out;
}

function paragraphs(src) {
  return String(src ?? '')
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== '')
    .map((p) => html`<p>${inline(p)}</p>`);
}

function inline(src) {
  // Inline code first, so the code spans are not re-processed for emphasis.
  // Plain strings are fine as children: htm turns them into text nodes.
  const parts = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) parts.push(src.slice(last, m.index));
    parts.push(html`<code>${m[1]}</code>`);
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push(src.slice(last));
  return parts;
}

/** An OAuth event is an object ({type, url}, {type, userCode}, ...), not a string. */
function eventText(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (e.type === 'auth_url') return e.url ?? '';
  if (e.type === 'device_code') return `code: ${e.userCode ?? e.code ?? ''}`;
  if (e.type === 'message') return e.message ?? '';
  return e.message ?? e.text ?? JSON.stringify(e);
}

// ── state ────────────────────────────────────────────────────────────────
const state = {
  ready: false,
  error: null,
  busy: false,
  model: null,
  usage: null,          // the session usage, as /api/state reports it
  usageTotal: null,     // the whole-harness total, from /api/usage
  usageSession: null,   // the session slice of /api/usage
  thinkingLevel: null,  // the agent's thinking level, from /api/state
  inbox: [],
  sessionName: 'Main',
  entries: [],          // { id, kind: 'user'|'assistant'|'sys', text, tone }
  seen: new Set(),
  pending: [],          // optimistic user messages awaiting their entry
  live: null,           // the assistant message being streamed
  tools: new Map(),     // callId -> { name, brief, out, status, child }
  mode: 'followUp',     // 'followUp' | 'steer'
  sheet: null,          // null | 'menu' | 'model' | 'thinking' | 'provider'
                        //      | 'addkey' | 'oauth' | 'sessions' | 'usage'
  models: [],
  sessions: [],
  providers: [],        // the keys that are set
  catalog: [],          // every provider that takes an API key
  oauthProviders: [],
  thinking: { level: 'off', supported: ['off'] },
  addKeyFor: null,      // the provider id being keyed
  oauth: null,          // { id, prompt, done, error, events }
  notice: null,         // a one-line message in the sheet
};

const set = (patch) => Object.assign(state, patch);
// A full-tree diff per SSE frame is a full-tree diff per text delta while the agent is
// streaming, over a transcript that only grows. Coalesce into one frame: many events, one
// render, whatever the event rate.
let redrawQueued = false;
const redraw = () => {
  if (redrawQueued) return;
  redrawQueued = true;
  const paint = () => {
    redrawQueued = false;
    rememberScroll();
    render(html`<${App} />`, document.getElementById('app'));
    stickToBottom();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paint);
  else setTimeout(paint, 16);
};

// ── the transcript ───────────────────────────────────────────────────────
/** A monotonic counter: entries and tool calls share one order, so the transcript can be read causally. */
let ordinal = 0;
const nextOrdinal = () => ordinal++;

function pushEntry(entry) {
  if (entry?.id !== undefined) {
    if (state.seen.has(entry.id)) return;
    state.seen.add(entry.id);
  }
  if (entry?.kind === 'pi.reset') return void sys('— context reset —');
  if (entry?.kind === 'pi.compaction') return void sys('— earlier messages compacted —');

  for (const m of entry?.model ?? []) {
    if (m.role === 'user') {
      const body = textOf(m);
      const i = state.pending.findIndex((p) => p.text === body);
      if (i >= 0) {
        // Clear the flag on the RENDERED entry too: removing the slot from the
        // pending list left the message at half opacity for the rest of the run.
        const optimistic = state.entries.find((e) => e.kind === 'user' && e.pending && e.text === body);
        if (optimistic) optimistic.pending = false;
        state.pending.splice(i, 1);
      } else if (body) state.entries.push({ kind: 'user', text: body, ord: nextOrdinal() });
    } else if (m.role === 'assistant') {
      const body = textOf(m);
      if (body) state.entries.push({ kind: 'assistant', text: body, ord: nextOrdinal() });
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === 'toolCall') startTool(c.id, c.name, c.arguments);
      }
      if (m.stopReason === 'aborted') sys('(interrupted)');
      if (m.stopReason === 'error' && m.errorMessage) sys(`error: ${m.errorMessage}`, 'bad');
    } else if (m.role === 'toolResult') {
      const t = state.tools.get(m.toolCallId);
      if (t) {
        t.status = m.isError ? 'err' : 'done';
        if (m.details?.conversationId !== undefined) t.child = m.details.conversationId;
      } else if (m.toolName) {
        sys(`⚙ ${m.toolName}`, m.isError ? 'bad' : null);
      }
    }
  }
}

function sys(text, tone) {
  state.entries.push({ kind: 'sys', text, tone: tone || null, ord: nextOrdinal() });
}

function startTool(callId, name, args) {
  if (callId !== undefined && state.tools.has(callId)) return;
  const brief = args
    ? (args.command || args.path || args.pattern || args.task || JSON.stringify(args).slice(0, 80))
    : '';
  state.tools.set(callId, { name: name || 'tool', brief: String(brief ?? ''), out: '', status: 'run', ord: nextOrdinal() });
}

function renderSnapshot(snapshot) {
  state.entries = [];
  state.seen = new Set();
  state.pending = [];
  state.tools = new Map();
  state.live = null;
  ordinal = 0;

  for (const e of snapshot?.entries ?? []) pushEntry(e);
  const partial = snapshot?.generation?.message;
  if (partial) state.live = { text: textOf(partial) };

  for (const t of snapshot?.tools ?? []) {
    if (!t?.callId || t.status === 'done') continue;
    startTool(t.callId, t.name);
    const slot = state.tools.get(t.callId);
    if (slot && t.output) slot.out = t.output;
    if (slot && t.details?.conversationId !== undefined) slot.child = t.details.conversationId;
  }

  if (snapshot?.agent) set({ model: snapshot.agent.model ?? null });
  if (snapshot?.usage) set({ usage: snapshot.usage });
  if (snapshot?.inbox) set({ inbox: snapshot.inbox });
  set({ busy: Boolean(snapshot?.run) });
}

// ── events ───────────────────────────────────────────────────────────────
function handle(ev) {
  // The server wraps the attach-time snapshot in its OWN frame, and only later
  // batches arrive as pi-durable events. The old client handled this case
  // explicitly; without it the transcript is empty on every load, every
  // reconnect and every session switch.
  if (ev.type === 'bridge_snapshot') {
    renderSnapshot(ev.snapshot);
    if (ev.sessionName) set({ sessionName: ev.sessionName });
    redraw();
    return;
  }
  if (ev.type === 'bridge_error') {
    sys(`error: ${ev.error}`);
    redraw();
    return;
  }
  if (ev.type === 'bridge_connected') {
    return;
  }
  switch (ev.type) {
    case 'snapshot': renderSnapshot(ev); break;
    case 'run_start': set({ busy: true }); break;
    case 'run_end': set({ busy: false, live: null }); break;

    case 'message_start':
      if (ev.message?.role === 'assistant') set({ live: { text: textOf(ev.message) } });
      break;
    case 'message_update': {
      const live = state.live ?? { text: '' };
      for (const c of ev.changes ?? []) {
        if (c.type === 'text_delta') live.text += c.delta;
        else if (c.type === 'message') live.text = textOf(c.message);
      }
      set({ live });
      break;
    }
    case 'message_end': {
      if (ev.entry?.model?.[0]?.role === 'assistant') set({ live: null });
      pushEntry(ev.entry);
      break;
    }
    case 'entry_appended': pushEntry(ev.entry); break;

    case 'tool_execution_start': startTool(ev.toolCallId, ev.toolName, ev.args); break;
    case 'tool_execution_update': {
      const t = state.tools.get(ev.toolCallId);
      if (!t) break;
      if (ev.output?.set !== undefined) t.out = ev.output.set;
      else if (ev.output) {
        if (ev.output.trimStart) t.out = t.out.slice(ev.output.trimStart);
        if (ev.output.append) t.out += ev.output.append;
      }
      if (ev.details?.conversationId !== undefined) t.child = ev.details.conversationId;
      break;
    }
    case 'tool_execution_end': {
      const t = state.tools.get(ev.toolCallId);
      const failed = !ev.entry || ev.entry.model?.[0]?.isError;
      if (t) t.status = failed ? 'err' : 'done';
      if (ev.entry && ev.entry.id !== undefined) state.seen.add(ev.entry.id);
      break;
    }

    case 'agent_changed': set({ model: ev.agent?.model ?? null }); break;
    case 'usage_changed': set({ usage: ev.usage }); break;
    case 'inbox_update': set({ inbox: ev.items ?? [] }); break;
    case 'compaction_start': sys('compacting…'); break;
    case 'compaction_end': sys('compaction finished'); break;
    case 'auto_retry_start': sys(`retry ${ev.attempt}: ${ev.errorMessage || ''}`, 'bad'); break;
    case 'task_failed': sys(`error (${ev.kind}): ${ev.message}`, 'bad'); break;
    case 'submission': {
      const r = ev.record;
      if (r?.status === 'unanswered') sys(`not answered: ${r.reason?.type || r.reason || 'failed'}`, 'bad');
      break;
    }
    default: break;
  }
  redraw();
}

// EventSource cannot set a header, so the token rides in the query.
function subscribe() {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  source.onmessage = (m) => {
    try { handle(JSON.parse(m.data)); } catch { /* a malformed frame is not worth crashing over */ }
  };
  source.onerror = () => {
    set({ error: 'lost the connection — retrying' });
    redraw();
  };
  source.onopen = () => {
    set({ error: null, ready: true });
    redraw();
  };
  return source;
}

async function refreshState() {
  try {
    const s = await get('/api/state');
    set({
      model: s.model ?? null,
      // The menu shows the thinking level, so it has to be here, not fetched
      // by the sheet that displays it.
      thinking: { ...state.thinking, level: s.thinkingLevel ?? state.thinking.level ?? 'off' },
      busy: Boolean(s.busy),
      usage: s.usage ?? null,
      // The inbox arrives as the pi.inbox DOCUMENT, whose shape is {items:[...]}.
      inbox: s.inbox?.items ?? (Array.isArray(s.inbox) ? s.inbox : []),
      sessionName: s.sessionName ?? 'Main',
      error: null,
    });
  } catch (e) {
    set({ error: String(e.message || e) });
  }
  // The provider count is a menu hint, so it is fetched at boot rather than
  // when the provider sheet happens to be opened.
  try {
    const p = await get('/api/providers');
    set({ providers: p.providers ?? [] });
  } catch { /* the menu hint is not worth an error */ }
  redraw();
}

// ── actions ──────────────────────────────────────────────────────────────
async function send(text) {
  const body = text.trim();
  if (!body) return;
  const optimistic = { kind: 'user', text: body, pending: true, ord: nextOrdinal() };
  state.entries.push(optimistic);
  // The entry OBJECT, not its index: between this push and the POST resolving, an
  // assistant message or a system line can arrive, and the last entry is then not this one.
  state.pending.push({ text: body, entry: optimistic });
  set({ live: null });
  redraw();
  try {
    await post('/api/prompt', {
      message: body,
      requestId: requestId(),
      whenBusy: state.mode === 'steer' ? 'steer' : undefined,
    });
  } catch (e) {
    const i = state.pending.findIndex((p) => p.text === body);
    if (i >= 0) {
      state.pending[i].entry.pending = false;
      state.pending[i].entry.tone = 'bad';
      state.pending.splice(i, 1);
    }
    sys(`error: ${e.message || e}`, 'bad');
    redraw();
  }
}

async function stop() {
  try { await post('/api/abort'); } catch { /* the run is stopping anyway */ }
}

async function openSheet(which) {
  // A sheet is an overlay, not a navigation, so without this the Android back button exits the app with a
  // sheet open. Pushing a history entry lets the WebView's own back handling fire popstate, which closes it.
  if (state.sheet === null && typeof history.pushState === 'function') {
    try { history.pushState({ sheet: which }, ''); } catch { /* a file:// page may refuse */ }
  }
  set({ sheet: which, notice: null });
  try {
    if (which === 'model') {
      const r = await get('/api/models');
      set({ models: r.models ?? [] });
    } else if (which === 'thinking') {
      set({ thinking: await get('/api/thinking') });
    } else if (which === 'provider') {
      const r = await get('/api/providers');
      set({ providers: r.providers ?? [], catalog: r.catalog ?? [] });
      const o = await get('/api/oauth/providers');
      set({ oauthProviders: o.providers ?? [] });
    } else if (which === 'sessions') {
      const r = await get('/api/sessions');
      set({ sessions: r.sessions ?? r ?? [] });
    } else if (which === 'usage') {
      // /api/usage returns {session, total}; /api/state returns the session
      // usage directly. They are different shapes, so they get different fields.
      const u = await get('/api/usage');
      set({ usageTotal: u.total ?? null, usageSession: u.session ?? null });
    }
  } catch (e) {
    set({ notice: String(e.message || e) });
  }
  redraw();
}

async function saveKey(key) {
  if (!state.addKeyFor) return;
  const provider = state.addKeyFor;
  try {
    await post('/api/auth', { provider, key });
    await openSheet('provider');
    // After the sheet opened: openSheet resets the notice, so setting it before was pointless.
    set({ addKeyFor: null, notice: `${provider} key saved` });
  } catch (e) {
    set({ notice: String(e.message || e) });
    redraw();
  }
}

async function deleteKey(provider) {
  try {
    await post('/api/auth', { provider, delete: true });
    await openSheet('provider');
    set({ notice: `${provider} key removed` });
  } catch (e) {
    set({ notice: String(e.message || e) });
    redraw();
  }
}

async function setThinking(level) {
  try {
    await post('/api/thinking', { level });
    set({ thinking: { ...state.thinking, level }, sheet: 'menu' });
  } catch (e) {
    set({ notice: String(e.message || e) });
  }
  redraw();
}

// OAuth: start a login, then answer whatever the provider asks for.
async function startOauth(provider) {
  try {
    const r = await post('/api/oauth/start', { provider });
    set({ oauth: { id: r.id, prompt: null, done: false, error: null, events: [] }, sheet: 'oauth' });
    pollOauth();
  } catch (e) {
    set({ notice: String(e.message || e) });
    redraw();
  }
}

let oauthTimer = null;
async function pollOauth() {
  if (oauthTimer) clearTimeout(oauthTimer);
  oauthTimer = setTimeout(async () => {
    const o = state.oauth;
    if (!o || o.done) return;
    try {
      const r = await get(`/api/oauth/status?id=${encodeURIComponent(o.id)}`);
      const next = { ...o, prompt: r.prompt ?? null, done: Boolean(r.done), error: r.error ?? null,
                     events: [...(o.events ?? []), ...(r.events ?? [])] };
      set({ oauth: next });
      redraw();
      if (!next.done && !next.error) pollOauth();
    } catch (e) {
      set({ oauth: { ...o, error: String(e.message || e) } });
      redraw();
    }
  }, 1200);
}

async function answerOauth(value) {
  const o = state.oauth;
  if (!o?.prompt) return;
  try {
    await post('/api/oauth/respond', { id: o.id, promptId: o.prompt.id, value });
    set({ oauth: { ...o, prompt: null } });
    pollOauth();
  } catch (e) {
    set({ notice: String(e.message || e) });
    redraw();
  }
}

async function chooseModel(m) {
  try {
    await post('/api/model', { provider: m.provider, modelId: m.modelId });
    set({ model: { provider: m.provider, modelId: m.modelId } });
    set({ sheet: 'menu' });
  } catch (e) {
    set({ notice: String(e.message || e) });
  }
  redraw();
}

async function chooseSession(id) {
  try { await post('/api/sessions/select', { id }); await refreshState(); } catch { /* keep the old one */ }
  set({ sheet: null });
  redraw();
}

// ── components ───────────────────────────────────────────────────────────
function StatusStrip() {
  const queued = state.inbox?.length ?? 0;
  let tone = '';
  let label = state.busy ? 'working' : 'idle';
  if (state.error) { tone = 'bad'; label = state.error; }
  else if (state.busy) {
    const running = [...state.tools.values()].find((t) => t.status === 'run');
    if (running) label = `working · ${running.name}`;
    else tone = 'working';
  } else if (queued) { tone = 'warn'; label = `queued · ${queued}`; }

  return html`
    <div class=${`strip ${tone}`}>
      <span class="dot"></span>
      <span>${label}</span>
      ${queued && !state.busy ? html`<span>· ${queued} waiting</span>` : null}
    </div>`;
}

function Tool({ t }) {
  const open = t.status === 'err' || (t.out && t.out.length > 0);
  return html`
    <details class=${`tool ${t.status === 'err' ? 'err' : ''}`} open=${open}>
      <summary>
        <span class="caret">▶</span>
        <span class="name">${t.name}</span>
        <span class="brief">${t.child !== undefined ? `subagent #${t.child}` : t.brief}</span>
        <span class=${`state ${t.status === 'run' ? 'run' : t.status === 'err' ? 'err' : ''}`}>
          ${t.status === 'run' ? 'running' : t.status === 'err' ? 'failed' : 'done'}
        </span>
      </summary>
      ${t.out ? html`<pre>${t.out}</pre>` : null}
    </details>`;
}

function Message({ m }) {
  if (m.kind === 'sys') return html`<div class=${`sys ${m.tone || ''}`}>${m.text}</div>`;
  if (m.kind === 'tool') return html`<div class=${`tool ${m.tone === 'bad' ? 'err' : ''}`}><pre>${m.text}</pre></div>`;
  if (m.kind === 'user') {
    return html`<div class=${`msg user ${m.pending ? 'pending' : ''} ${m.tone === 'bad' ? 'failed' : ''}`}>
      <div class="body">${m.text}</div>
    </div>`;
  }
  return html`<div class="msg assistant"><div class="body">${markdown(m.text)}</div></div>`;
}

function Transcript() {
  // One list, ordered by when each thing happened: a tool call that happened between two
  // answers belongs BETWEEN them, not in a block at the bottom.
  const items = [];
  for (const m of state.entries) items.push({ ord: m.ord ?? 0, node: html`<${Message} key=${`e${m.ord ?? 0}`} m=${m} />` });
  for (const [id, t] of state.tools) items.push({ ord: t.ord ?? 0, node: html`<${Tool} key=${`t${id}`} t=${t} />` });
  items.sort((a, b) => a.ord - b.ord);
  const nodes = items.map((i) => i.node);
  if (state.live) nodes.push(html`<div class="msg assistant live" key="live"><div class="body">${markdown(state.live.text)}</div></div>`);
  return html`<div class="log" id="log">${nodes}</div>`;
}

function Composer() {
  const busy = state.busy;
  return html`
    <form class="composer" onSubmit=${async (e) => {
      e.preventDefault();
      const ta = e.target.querySelector('textarea');
      const value = ta.value;
      ta.value = '';
      ta.style.height = 'auto';
      await send(value);
    }}>
      <div class="modes" hidden=${!busy}>
        <span class="label">send as</span>
        <div class="seg">
          <button type="button" aria-pressed=${state.mode === 'steer'} onClick=${() => { set({ mode: 'steer' }); redraw(); }}>Steer</button>
          <button type="button" aria-pressed=${state.mode === 'followUp'} onClick=${() => { set({ mode: 'followUp' }); redraw(); }}>Queue</button>
        </div>
      </div>
      <div class="field">
        <textarea name="message" rows="1" placeholder=${busy ? 'Steer the running work…' : 'Message pi…'}
          onInput=${(e) => {
            const ta = e.target;
            ta.style.height = 'auto';
            ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
          }}></textarea>
        ${busy ? html`<button class="send stop" type="button" aria-label="Stop" onClick=${() => stop()}>■</button>` : null}
        <button class="send" type="submit" aria-label="Send">↑</button>
      </div>
    </form>`;
}

function closeSheet() {
  if (state.sheet !== null && typeof history.back === 'function') {
    // Let the history entry go back rather than rewriting the URL: the browser's own back
    // then lands where it should.
    try { history.back(); return; } catch { /* fall through */ }
  }
  set({ sheet: null });
  redraw();
}

function Scrim() {
  return html`<div class="scrim" onClick=${closeSheet}></div>`;
}

function MenuSheet() {
  const level = state.thinking?.level ?? 'off';
  const items = [
    { label: 'Model', hint: modelLabel(state.model), go: () => openSheet('model') },
    { label: 'Thinking', hint: level === 'off' ? 'off' : level[0].toUpperCase() + level.slice(1), go: () => openSheet('thinking') },
    { label: 'Provider', hint: state.providers?.length ? `${state.providers.length} key${state.providers.length > 1 ? 's' : ''}` : 'not set', go: () => openSheet('provider') },
    { label: 'Sessions', hint: state.sessionName, go: () => openSheet('sessions') },
    { label: 'Usage', hint: usageShort(state.usage), go: () => openSheet('usage') },
  ];
  return html`
    <div class="sheet">
      <div class="grab"></div>
      <header><h2>pi</h2>
        <button class="icon" onClick=${closeSheet} aria-label="Close">✕</button>
      </header>
      <div class="body">
        ${items.map((it) => html`
          <button class="row" key=${it.label} onClick=${it.go}>
            <span class="grow">${it.label}</span>
            <small>${it.hint}</small>
          </button>`)}
        <button class="row" onClick=${async () => { await post('/api/sessions/new').catch(() => {}); set({ sheet: null }); redraw(); }}>
          <span class="grow">New session</span>
        </button>
        <button class="row" onClick=${async () => { await post('/api/new').catch(() => {}); set({ sheet: null }); redraw(); }}>
          <span class="grow">Reset this conversation</span>
        </button>
        <button class="row" onClick=${async () => { await post('/api/compact').catch(() => {}); set({ sheet: null }); redraw(); }}>
          <span class="grow">Compact context</span>
        </button>
        <button class="row" onClick=${async () => {
          try { const r = await post('/api/pi-update'); set({ notice: r.message || 'updating' }); }
          catch (e) { set({ notice: String(e.message || e) }); }
          redraw();
        }}>
          <span class="grow">Update pi</span>
        </button>
      </div>
    </div>`;
}

function ThinkingSheet() {
  const supported = state.thinking?.supported ?? ['off'];
  const level = state.thinking?.level ?? 'off';
  return html`
    <div class="sheet">
      <div class="grab"></div>
      <header>
        <button class="icon" onClick=${() => openSheet('menu')} aria-label="Back">‹</button>
        <h2>Thinking</h2>
        <button class="icon" onClick=${closeSheet} aria-label="Close">✕</button>
      </header>
      <div class="body">
        ${supported.length <= 1 && supported[0] === 'off'
          ? html`<div class="empty">${state.model ? 'This model does not take a thinking level.' : 'Pick a model first.'}</div>`
          : supported.map((l) => html`
              <button class="row" key=${l} aria-pressed=${level === l} onClick=${() => setThinking(l)}>
                <span class="grow">${l === 'off' ? 'Off' : l[0].toUpperCase() + l.slice(1)}</span>
              </button>`)}
      </div>
    </div>`;
}

function ProviderSheet() {
  const configured = state.providers ?? [];
  const oauth = state.oauthProviders ?? [];
  return html`
    <div class="sheet">
      <div class="grab"></div>
      <header>
        <button class="icon" onClick=${() => openSheet('menu')} aria-label="Back">‹</button>
        <h2>Provider</h2>
        <button class="icon" onClick=${closeSheet} aria-label="Close">✕</button>
      </header>
      <div class="body">
        ${state.notice ? html`<div class="row"><span class="grow">${state.notice}</span></div>` : null}
        ${configured.length
          ? configured.map((p) => html`
              <button class="row" key=${p.provider} onClick=${() => deleteKey(p.provider)}>
                <span class="grow">${p.provider}</span>
                <small>${p.keyHint || p.type} · tap to remove</small>
              </button>`)
          : html`<div class="empty">No provider keys yet.</div>`}
        ${oauth.length ? html`<div class="row"><span class="grow" style="color:var(--muted);font-size:12px">Sign in</span></div>` : null}
        ${oauth.map((p) => html`
          <button class="row" key=${'oauth-' + p.id} onClick=${() => startOauth(p.id)}>
            <span class="grow">${p.label || p.name || p.id}</span>
          </button>`)}
        <div class="row"><span class="grow" style="color:var(--muted);font-size:12px">Add an API key</span></div>
        ${(state.catalog ?? []).map((p) => html`
          <button class="row" key=${'api-' + p.id} onClick=${() => { set({ addKeyFor: p.id, sheet: 'addkey' }); redraw(); }}>
            <span class="grow">${p.name || p.id}</span>
          </button>`)}
      </div>
    </div>`;
}

function AddKeySheet() {
  return html`
    <div class="sheet">
      <div class="grab"></div>
      <header>
        <button class="icon" onClick=${() => openSheet('provider')} aria-label="Back">‹</button>
        <h2>${state.addKeyFor} key</h2>
        <button class="icon" onClick=${closeSheet} aria-label="Close">✕</button>
      </header>
      <div class="body">
        <div class="row" style="display:block">
          <input class="keyin" type="password" placeholder="API key" autocomplete="off" spellcheck=${false}
            onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); const v = e.target.value; saveKey(v); } }} />
          <button class="savekey" onClick=${(e) => saveKey(e.target.closest('.row').querySelector('input').value)}>Save</button>
        </div>
        ${state.notice ? html`<div class="row"><span class="grow">${state.notice}</span></div>` : null}
      </div>
    </div>`;
}

function OauthSheet() {
  const o = state.oauth ?? {};
  return html`
    <div class="sheet">
      <div class="grab"></div>
      <header>
        <button class="icon" onClick=${() => { set({ sheet: 'provider' }); redraw(); }} aria-label="Back">‹</button>
        <h2>Sign in</h2>
        <button class="icon" onClick=${closeSheet} aria-label="Close">✕</button>
      </header>
      <div class="body">
        ${o.error ? html`<div class="empty" style="color:var(--bad)">${o.error}</div>` : null}
        ${o.done ? html`<div class="empty">Signed in. You can close this.</div>` : null}
        ${(o.events ?? []).map((e, i) => html`<div class="row" key=${'e' + i}><span class="grow">${eventText(e)}</span></div>`)}
        ${(o.events ?? []).filter((e) => e && e.type === 'auth_url').map((e, i) => html`
          <div class="row" key=${'au' + i}>
            <span class="grow">Open the sign-in page</span>
            <button class="row" onClick=${() => { location.assign(e.url); }}>Open</button>
          </div>`)}
        ${(o.events ?? []).filter((e) => e && e.type === 'device_code').map((e, i) => html`
          <div class="row" key=${'dc' + i}>
            <span class="grow">${e.userCode ?? e.code ?? ''}<br /><small>${e.verificationUri ?? e.verification_uri ?? ''}</small></span>
          </div>`)}
        ${o.prompt ? html`
          <div class="row" style="display:block">
            <div style="margin-bottom:8px">${o.prompt.message || o.prompt.type}</div>
            ${o.prompt.options?.length
              ? o.prompt.options.map((opt) => html`<button class="row" key=${opt.id ?? opt.label ?? String(opt)} onClick=${() => answerOauth(opt.id ?? opt.label ?? opt)}><span class="grow">${opt.label ?? opt.name ?? String(opt)}</span></button>`)
              : html`<input class="keyin" type="text" placeholder=${o.prompt.placeholder || 'value'} autocomplete="off"
                  onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); answerOauth(e.target.value); } }} />`}
          </div>` : null}
      </div>
    </div>`;
}

function Sheet() {
  const which = state.sheet;
  if (!which) return null;
  if (which === 'menu') return html`<${Scrim} /><${MenuSheet} />`;
  if (which === 'thinking') return html`<${Scrim} /><${ThinkingSheet} />`;
  if (which === 'provider') return html`<${Scrim} /><${ProviderSheet} />`;
  if (which === 'addkey') return html`<${Scrim} /><${AddKeySheet} />`;
  if (which === 'oauth') return html`<${Scrim} /><${OauthSheet} />`;
  const title = which === 'model' ? 'Model' : which === 'sessions' ? 'Sessions' : 'Usage';
  let body;
  if (which === 'model') {
    const models = state.models?.models ?? state.models ?? [];
    const current = state.model?.modelId;
    body = models.length
      ? models.map((m) => {
          const id = m.modelId ?? m.id ?? m;
          return html`<button class="row" key=${id} aria-pressed=${current === id} onClick=${() => chooseModel({ provider: m.provider, modelId: id })}>
            <span class="grow">${m.name ?? id}</span>
            <small>${m.provider}${m.thinkingLevels?.length > 1 ? ` · thinks: ${m.thinkingLevels.join(', ')}` : ''}</small>
          </button>`;
        })
      : html`<div class="empty">No models yet — add a provider key in the menu.</div>`;
  } else if (which === 'sessions') {
    const sessions = state.sessions?.sessions ?? state.sessions ?? [];
    body = sessions.length
      ? sessions.map((s) => {
          const id = s.id ?? s;
          return html`<button class="row" key=${id} onClick=${() => chooseSession(id)}>
            <span class="grow">${s.name ?? id}${s.id === state.sessionId || s.name === state.sessionName ? ' ·' : ''}</span>
            ${s.cwd ? html`<small>${s.cwd}</small>` : null}
          </button>`;
        })
      : html`<div class="empty">No sessions yet.</div>`;
  } else {
    // /api/usage returns {session, total}; the session usage has the same shape as /api/state's.
    const session = state.usageSession ?? state.usage ?? {};
    const rows = Object.entries(session.models ?? {});
    const total = state.usageTotal;
    body = rows.length || total
      ? [
          ...rows.map(([m, u]) => html`<div class="row" key=${m}>
            <span class="grow">${m}</span>
            <span>${(u.totalTokens ?? 0).toLocaleString()} tok${u.cost?.total ? ` · $${u.cost.total.toFixed(3)}` : ''}</span>
          </div>`),
          total
            ? html`<div class="row" key=${'total'}>
                <span class="grow">Everything</span>
                <span>${(total.totalTokens ?? 0).toLocaleString()} tok${total.cost?.total ? ` · $${total.cost.total.toFixed(3)}` : ''}</span>
              </div>`
            : null,
        ]
      : html`<div class="empty">No usage yet.</div>`;
  }
  return html`
    <div class="sheet">
      <div class="grab"></div>
      <header>
        <h2>${title}</h2>
        <button class="icon" onClick=${closeSheet} aria-label="Close">✕</button>
      </header>
      <div class="body">${body}</div>
    </div>`;
}

function App() {
  return html`
    <div class="top">
      <div class="top-row">
        <div class="brand">
          <b>pi</b>
          <span class="who">${state.sessionName}</span>
        </div>
        <button class="icon" aria-label="Menu" onClick=${() => openSheet('menu')}>☰</button>
        <button class="icon" aria-label="Model" onClick=${() => openSheet('model')}>${modelShort(state.model)}</button>
      </div>
      <${StatusStrip} />
    </div>
    <${Transcript} />
    <${Composer} />
    <${Sheet} />`;
}

function modelLabel(model) {
  if (!model) return 'not set';
  return model.modelId ?? model.id ?? String(model);
}

function usageShort(usage) {
  let tokens = 0;
  let cost = 0;
  for (const u of Object.values(usage?.models ?? {})) {
    tokens += u.totalTokens || 0;
    cost += u.cost?.total || 0;
  }
  if (!tokens) return '–';
  return `${tokens.toLocaleString()} tok${cost ? ` · $${cost.toFixed(3)}` : ''}`;
}

function modelShort(model) {
  if (!model) return '–';
  // The agent doc stores the model as {provider, modelId} -- the same shape /api/model is given.
  const s = typeof model === 'string' ? model : (model.modelId ?? model.id ?? model.model ?? '');
  return String(s).split('/').pop().slice(0, 12) || '–';
}

// ── keep the transcript pinned to the bottom while it grows ──────────────
// Whether the view was at the bottom BEFORE the DOM changed. Measuring afterwards means one tall
// frame (a snapshot, a long answer) puts the distance over the threshold and the view stops
// following -- permanently, because the next measurement is from an even greater distance.
let wasAtBottom = true;
function stickToBottom() {
  const log = document.getElementById('log');
  if (!log) return;
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
}
function rememberScroll() {
  const log = document.getElementById('log');
  if (!log) return;
  wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
}

// The Android back button, in a WebView, is a history pop. Close the sheet when it fires.
if (typeof addEventListener === 'function') {
  addEventListener('popstate', () => {
    if (state.sheet !== null) {
      set({ sheet: null });
      redraw();
    }
  });
}

// ── boot ─────────────────────────────────────────────────────────────────
subscribe();
refreshState();
redraw();

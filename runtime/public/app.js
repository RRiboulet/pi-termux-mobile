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

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({ error: `http ${r.status}` }));
  if (!r.ok) throw new Error(j.error || `http ${r.status}`);
  return j;
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
  const blocks = String(src ?? '').split(/```/);
  blocks.forEach((block, i) => {
    if (i === 0) { out.push(...paragraphs(block)); return; }
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

// ── state ────────────────────────────────────────────────────────────────
const state = {
  ready: false,
  error: null,
  busy: false,
  model: null,
  usage: null,
  inbox: [],
  sessionName: 'Main',
  entries: [],          // { id, kind: 'user'|'assistant'|'sys', text, tone }
  seen: new Set(),
  pending: [],          // optimistic user messages awaiting their entry
  live: null,           // the assistant message being streamed
  tools: new Map(),     // callId -> { name, brief, out, status, child }
  mode: 'followUp',     // 'followUp' | 'steer'
  sheet: null,          // null | 'model' | 'sessions' | 'usage'
  models: [],
  sessions: [],
};

const set = (patch) => Object.assign(state, patch);
const redraw = () => {
  render(html`<${App} />`, document.getElementById('app'));
  stickToBottom();
};

// ── the transcript ───────────────────────────────────────────────────────
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
      if (i >= 0) state.pending.splice(i, 1);
      else if (body) state.entries.push({ kind: 'user', text: body });
    } else if (m.role === 'assistant') {
      const body = textOf(m);
      if (body) state.entries.push({ kind: 'assistant', text: body });
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
  state.entries.push({ kind: 'sys', text, tone: tone || null });
}

function startTool(callId, name, args) {
  if (callId !== undefined && state.tools.has(callId)) return;
  const brief = args
    ? (args.command || args.path || args.pattern || args.task || JSON.stringify(args).slice(0, 80))
    : '';
  state.tools.set(callId, { name: name || 'tool', brief: String(brief ?? ''), out: '', status: 'run' });
}

function renderSnapshot(snapshot) {
  state.entries = [];
  state.seen = new Set();
  state.pending = [];
  state.tools = new Map();
  state.live = null;

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
      busy: Boolean(s.busy),
      usage: s.usage ?? null,
      inbox: s.inbox ?? [],
      sessionName: s.sessionName ?? 'Main',
      error: null,
    });
  } catch (e) {
    set({ error: String(e.message || e) });
  }
  redraw();
}

// ── actions ──────────────────────────────────────────────────────────────
async function send(text) {
  const body = text.trim();
  if (!body) return;
  state.entries.push({ kind: 'user', text: body, pending: true });
  state.pending.push({ text: body });
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
    if (i >= 0) state.pending.splice(i, 1);
    const last = state.entries[state.entries.length - 1];
    if (last && last.pending) { last.pending = false; last.tone = 'bad'; }
    sys(`error: ${e.message || e}`, 'bad');
    redraw();
  }
}

async function stop() {
  try { await post('/api/abort'); } catch { /* the run is stopping anyway */ }
}

async function openSheet(which) {
  set({ sheet: which });
  if (which === 'model') {
    try { set({ models: await get('/api/models') }); } catch { set({ models: [] }); }
  } else if (which === 'sessions') {
    try { set({ sessions: await get('/api/sessions') }); } catch { set({ sessions: [] }); }
  }
  redraw();
}

async function chooseModel(m) {
  try { await post('/api/model', { model: m }); set({ model: m }); } catch { /* keep the old one */ }
  set({ sheet: null });
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
    <details class=${`tool ${t.status === 'err' ? 'err' : ''}`} open=${open ? '' : null}>
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
  const items = [];
  for (const m of state.entries) items.push(html`<${Message} key=${`e${items.length}`} m=${m} />`);
  for (const [id, t] of state.tools) items.push(html`<${Tool} key=${`t${id}`} t=${t} />`);
  if (state.live) items.push(html`<div class="msg assistant live" key="live"><div class="body">${markdown(state.live.text)}</div></div>`);
  return html`<div class="log" id="log">${items}</div>`;
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
      ${busy ? html`
        <div class="modes">
          <span class="label">send as</span>
          <div class="seg">
            <button type="button" aria-pressed=${state.mode === 'steer'} onClick=${() => { set({ mode: 'steer' }); redraw(); }}>Steer</button>
            <button type="button" aria-pressed=${state.mode === 'followUp'} onClick=${() => { set({ mode: 'followUp' }); redraw(); }}>Queue</button>
          </div>
        </div>` : null}
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

function Sheet() {
  const which = state.sheet;
  if (!which) return null;
  const title = which === 'model' ? 'Model' : which === 'sessions' ? 'Sessions' : 'Usage';
  let body;
  if (which === 'model') {
    const models = state.models?.models ?? state.models ?? [];
    body = models.length
      ? models.map((m) => {
          const id = m.id ?? m.model ?? m;
          const name = m.name ?? m.label ?? id;
          return html`<button class="row" key=${id} aria-pressed=${state.model === id} onClick=${() => chooseModel(id)}>
            <span class="grow">${name}</span>
            ${m.provider ? html`<small>${m.provider}</small>` : null}
          </button>`;
        })
      : html`<div class="empty">No models yet — add a provider key in the app.</div>`;
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
    const usage = state.usage ?? {};
    const rows = Object.entries(usage.models ?? {});
    body = rows.length
      ? rows.map(([m, u]) => html`<div class="row" key=${m}>
          <span class="grow">${m}</span>
          <span>${(u.totalTokens ?? 0).toLocaleString()} tok${u.cost?.total ? ` · $${u.cost.total.toFixed(3)}` : ''}</span>
        </div>`)
      : html`<div class="empty">No usage yet.</div>`;
  }
  return html`
    <div class="scrim" onClick=${() => { set({ sheet: null }); redraw(); }}></div>
    <div class="sheet">
      <div class="grab"></div>
      <header>
        <h2>${title}</h2>
        <button class="icon" onClick=${() => { set({ sheet: null }); redraw(); }} aria-label="Close">✕</button>
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
        <button class="icon" aria-label="Sessions" onClick=${() => openSheet('sessions')}>☰</button>
        <button class="icon" aria-label="Usage" onClick=${() => openSheet('usage')}>◔</button>
        <button class="icon" aria-label="Model" onClick=${() => openSheet('model')}>${modelShort(state.model)}</button>
      </div>
      <${StatusStrip} />
    </div>
    <${Transcript} />
    <${Composer} />
    <${Sheet} />`;
}

function modelShort(model) {
  if (!model) return '–';
  const s = typeof model === 'string' ? model : (model.id ?? model.model ?? '');
  return String(s).split('/').pop().slice(0, 12) || '–';
}

// ── keep the transcript pinned to the bottom while it grows ──────────────
function stickToBottom() {
  const log = document.getElementById('log');
  if (!log) return;
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
  if (near) log.scrollTop = log.scrollHeight;
}

// ── boot ─────────────────────────────────────────────────────────────────
subscribe();
refreshState();
redraw();

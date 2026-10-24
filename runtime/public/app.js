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

// ── the document this client booted into ─────────────────────────────────
// Bound once at boot, like `location.search` below: the paint path must reach
// the DOM this instance was loaded into, whatever `document` means by then.
const doc = document;

// ── storage ──────────────────────────────────────────────────────────────
// localStorage throws when DOM storage is disabled, and this module runs at load,
// where a throw is a blank app and no error anyone can read. Every access is here.
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};

// ── token ────────────────────────────────────────────────────────────────
// The Activity loads /?token=...; keep it in localStorage and take it out of
// the address bar, so it is not left in a screenshot or a history entry.
const params = new URLSearchParams(location.search);
let token = params.get('token') || store.get('pi-token') || '';
if (token) {
  store.set('pi-token', token);
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
 * POST, with the retry: a phone loses the bridge for a moment all the time,
 * and the body carries a requestId, so a retried prompt is answered once and
 * only once.
 *
 * A 4xx is not retried: it is an answer, not a lost bridge. The install gate
 * answers 409 when the file changed since the user saw it, and retrying that
 * would run the proposal's code again for nothing.
 */
async function post(path, body, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body ?? {}) });
    } catch (e) {
      // The bridge is gone. That is worth another try.
      if (attempt >= retries) throw e;
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
      continue;
    }
    const j = await r.json().catch(() => ({ error: `http ${r.status}` }));
    if (r.status === 503 && j.reconnecting && attempt < retries) {
      await new Promise((res) => setTimeout(res, 1500));
      continue;
    }
    if (!r.ok) {
      if (r.status >= 500 && attempt < retries) {
        await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
        continue;
      }
      throw new Error(j.error || `http ${r.status}`);
    }
    return j;
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

// Thinking blocks, kept per content index so a message with several of them
// (or a redacted one between two live ones) reassembles in the right order.
// A block whose text is empty is dropped: redacted thinking arrives whole with
// its payload in `thinkingSignature`, and there is nothing to show for it.
function thinkingSegments(message) {
  const out = [];
  if (!Array.isArray(message?.content)) return out;
  message.content.forEach((c, i) => {
    if (c?.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim()) out[i] = c.thinking;
  });
  return out;
}

function thoughtsText(segments) {
  return (segments ?? []).filter(Boolean).join('\n\n');
}

function thinkingOf(message) {
  return thoughtsText(thinkingSegments(message));
}

// ── markdown ─────────────────────────────────────────────────────────────
// Block level: ATX headings, fenced code, bullet and ordered lists,
// blockquotes, pipe tables, rules, paragraphs. Inline: code, bold, italic,
// strikethrough, links.
//
// Everything becomes a vnode. Model output is never turned into an HTML
// string, so nothing a reply contains can execute anything; the only attribute
// it can influence is a link href, and only http(s)/mailto survive that.

const RE_FENCE   = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_RULE    = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const RE_QUOTE   = /^\s*>\s?(.*)$/;
const RE_ITEM    = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RE_TDIV    = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const RE_INLINE  = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|(?<![\w*])\*(?!\*)((?:\*\*[^*\n]+?\*\*|[^*\n])+?)\*(?![\w*])|(?<![\w])_(?!_)((?:__[^_\n]+?__|[^_\n])+?)_(?![\w])|\[([^\[\]\n]{0,200})\]\(([^)\s]{1,400})\)/g;

const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTable = (lines, i) => {
  if (!lines[i]?.includes('|') || lines[i + 1] === undefined || !RE_TDIV.test(lines[i + 1])) return false;
  // header and separator must agree on the column count, so `a|b` followed by
  // a plain `---` rule does not become a table
  return splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
};
const startsBlock = (lines, i) =>
  !lines[i].trim() || RE_FENCE.test(lines[i]) || RE_HEADING.test(lines[i]) ||
  RE_RULE.test(lines[i]) || RE_QUOTE.test(lines[i]) || RE_ITEM.test(lines[i]) || isTable(lines, i);

function markdown(src) {
  return blocks(String(src ?? '').replace(/\r\n?/g, '\n').split('\n'));
}

// Soft line breaks inside a paragraph are kept as <br>, which is what the
// transcript did before with white-space: pre-wrap.
const linesToNodes = (ls) => ls.flatMap((l, i) => (i ? [h('br'), ...inline(l)] : inline(l)));

function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const key = out.length;

    if (!lines[i].trim()) { i++; continue; }

    // ── fenced code
    const fence = RE_FENCE.exec(lines[i]);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) { body.push(lines[i]); i++; }
      if (i < lines.length) i++;
      out.push(h('div', { class: 'fence', key: 'f' + key }, fence[2] || 'code'));
      out.push(h('pre', { key: 'p' + key }, h('code', null, body.join('\n'))));
      continue;
    }

    // ── heading
    const head = RE_HEADING.exec(lines[i]);
    if (head) {
      out.push(h('h' + head[1].length, { key }, inline(head[2])));
      i++;
      continue;
    }

    // ── rule
    if (RE_RULE.test(lines[i])) { out.push(h('hr', { key })); i++; continue; }

    // ── blockquote (its contents are parsed as blocks again)
    if (RE_QUOTE.test(lines[i])) {
      const inner = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) { inner.push(RE_QUOTE.exec(lines[i])[1]); i++; }
      out.push(h('blockquote', { key }, blocks(inner)));
      continue;
    }

    // ── pipe table
    if (isTable(lines, i)) {
      const cells = splitRow;
      const head = cells(lines[i]);
      const align = cells(lines[i + 1]).map((c) => {
        const left = c.startsWith(':'), right = c.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
      });
      const style = (k) => (align[k] ? { style: `text-align:${align[k]}` } : null);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i])); i++; }
      out.push(h('div', { class: 'tablewrap', key },
        h('table', null,
          h('thead', null, h('tr', null, head.map((c, k) => h('th', style(k), inline(c))))),
          rows.length
            ? h('tbody', null, rows.map((r) => h('tr', null,
                head.map((_, k) => h('td', style(k), inline(r[k] ?? ''))))))
            : null)));
      continue;
    }

    // ── list
    const item = RE_ITEM.exec(lines[i]);
    if (item) {
      const indent = item[1].length;
      const ordered = /\d/.test(item[2]);
      const items = [];
      while (i < lines.length) {
        const m = RE_ITEM.exec(lines[i]);
        if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
        const buf = [m[3]];
        i++;
        // more-indented lines, and blank lines followed by more of this list
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            const next = RE_ITEM.exec(lines[i + 1] ?? '');
            if (next && next[1].length === indent && /\d/.test(next[2]) === ordered) { i++; break; }
            if (next && next[1].length > indent) { i++; continue; }
            break;
          }
          if (l.length - l.trimStart().length > indent) { buf.push(l.trim()); i++; continue; }
          break;
        }
        items.push(buf);
      }
      out.push(h(ordered ? 'ol' : 'ul', { key },
        items.map((buf) => h('li', null, linesToNodes(buf)))));
      continue;
    }

    // ── paragraph
    const para = [];
    while (i < lines.length && !startsBlock(lines, i)) { para.push(lines[i]); i++; }
    out.push(h('p', { key }, linesToNodes(para)));
  }
  return out;
}

// Only http(s) and mailto links are emitted; anything else stays as written.
function safeHref(url) {
  const s = String(url ?? '').trim();
  return /^(https?:|mailto:)/i.test(s) ? s : null;
}

function inline(src, depth = 0) {
  const text = String(src ?? '');
  if (!text) return [];
  const out = [];
  // a fresh lastIndex per call, because emphasis recurses into this function
  const re = new RegExp(RE_INLINE.source, 'g');
  const inner = (s) => (depth < 3 ? inline(s, depth + 1) : [s]);
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(h('code', null, m[2]));
    else if (m[3] !== undefined || m[4] !== undefined) out.push(h('strong', null, inner(m[3] ?? m[4])));
    else if (m[5] !== undefined) out.push(h('del', null, inner(m[5])));
    else if (m[6] !== undefined || m[7] !== undefined) out.push(h('em', null, inner(m[6] ?? m[7])));
    else if (m[8] !== undefined) {
      const href = safeHref(m[9]);
      out.push(href
        ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, m[8])
        : m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ── state ────────────────────────────────────────────────────────────────
const state = {
  ready: false,
  lastSeq: Number(store.get('pi-lastSeq') || 0), // the frame this client last saw
  epoch: store.get('pi-epoch'),                  // the bridge run that number belongs to
  error: null,
  busy: false,
  model: null,
  usage: null,          // the session usage, as /api/state reports it
  contextTokens: 0,     // estimated tokens in the current context
  usageTotal: null,     // the whole-harness total, from /api/usage
  usageSession: null,   // the session slice of /api/usage
  inbox: [],
  sessionName: 'Main',
  sessionId: null,      // which session /api/state says is active
  pi: null,             // /api/pi-update: the version installed, and any update in flight
  entries: [],          // { kind: 'user'|'assistant'|'sys', text?, blocks?, thinking?, tone? }
  copied: new Set(),   // keys of assistant messages whose copy feedback is showing
  seen: new Set(),
  attachedTools: new Set(), // tool calls already placed in the transcript
  pending: [],          // optimistic user messages awaiting their entry
  live: null,           // the assistant message being streamed: { text, think[] }
  tools: new Map(),     // callId -> { name, brief, out, status: 'run'|'queued'|'done'|'err', child }
  sheet: null,          // null | 'menu' | 'model' | 'thinking' | 'provider'
                        //      | 'addkey' | 'oauth' | 'sessions' | 'usage' | 'extensions'
  models: [],
  sessions: [],
  extensions: { installed: [], proposals: [], problems: [] },  // the install gate's state
  providers: [],        // the keys that are set
  catalog: [],          // every provider that takes an API key
  oauthProviders: [],
  thinking: { level: 'off', supported: ['off'] },
  addKeyFor: null,      // the provider id being keyed
  oauth: null,          // { id, prompt, done, error, events }
  notice: null,         // a one-line message in the sheet
};

const set = (patch) => Object.assign(state, patch);
// A full-tree diff per SSE frame is a full-tree diff per text delta while the
// agent streams, over a transcript that only grows. Coalesce into one frame.
let redrawQueued = false;
const redraw = () => {
  if (redrawQueued) return;
  redrawQueued = true;
  const paint = () => {
    redrawQueued = false;
    rememberScroll();
    render(html`<${App} />`, doc.getElementById('app'));
    stickToBottom();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paint);
  else setTimeout(paint, 16);
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
      if (i >= 0) {
        // Clear the flag on the RENDERED entry too: removing the slot from the
        // pending list left the message at half opacity for the rest of the run.
        const optimistic = state.entries.find((e) => e.kind === 'user' && e.pending && e.text === body);
        if (optimistic) optimistic.pending = false;
        state.pending.splice(i, 1);
      } else if (body) state.entries.push({ kind: 'user', text: body });
    } else if (m.role === 'assistant') {
      const thoughts = thinkingOf(m);
      // The blocks in the order the message wrote them: a sentence, the call it
      // makes, the sentence after it. Collecting the calls into a list of their
      // own and rendering that list above the text put a running tool above the
      // line that introduced it, and made anything said after a call read
      // backwards. The order the model wrote is the only order that is not a
      // guess.
      const blocks = [];
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === 'toolCall') {
          // `false`: a tool call recorded in history is not a live one.
          startTool(c.id, c.name, c.arguments, false);
          if (c.id === undefined || state.attachedTools.has(c.id)) continue;
          state.attachedTools.add(c.id);
          blocks.push({ type: 'tool', id: c.id });
        } else if (c?.type === 'text' && typeof c.text === 'string' && c.text) {
          const last = blocks[blocks.length - 1];
          // Adjacent text blocks are one run of prose, not two: rendering them
          // apart would put a margin between two halves of one sentence.
          if (last?.type === 'text') last.text += `\n${c.text}`;
          else blocks.push({ type: 'text', text: c.text });
        }
      }
      // A turn that only called a tool still deserves a row in the transcript.
      if (blocks.length || thoughts) {
        state.entries.push({ kind: 'assistant', blocks, thinking: thoughts });
      }
      if (m.stopReason === 'aborted') sys('(interrupted)');
      if (m.stopReason === 'error' && m.errorMessage) sys(`error: ${m.errorMessage}`, 'bad');
    } else if (m.role === 'toolResult') {
      const t = state.tools.get(m.toolCallId);
      if (t) {
        t.status = m.isError ? 'err' : 'done';
        t.out = textOf(m);
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

function startTool(callId, name, args, live = true) {
  if (callId !== undefined && state.tools.has(callId)) {
    // A tool first seen in committed history can still turn out to be running:
    // the history records the call before the harness starts it. Only a queued
    // call is promoted -- a finished one stays finished, however late it is
    // mentioned.
    const t = state.tools.get(callId);
    if (live && t.status === 'queued') t.status = 'run';
    return;
  }
  const brief = args
    ? (args.command || args.path || args.pattern || args.task || JSON.stringify(args).slice(0, 80))
    : '';
  // A call recorded in history has been made, not necessarily started: the
  // harness starts tools after the message is committed, and it may run them
  // one at a time. Calling that "running…" claimed a tool was working while it
  // was still waiting its turn.
  state.tools.set(callId, { name: name || 'tool', brief: String(brief ?? ''), out: '', status: live ? 'run' : 'queued' });
}

function renderSnapshot(snapshot) {
  state.entries = [];
  state.seen = new Set();
  state.attachedTools = new Set();
  state.pending = [];
  state.tools = new Map();
  state.live = null;

  for (const e of snapshot?.entries ?? []) pushEntry(e);
  const partial = snapshot?.generation?.message;
  if (partial) state.live = { text: textOf(partial), think: thinkingSegments(partial) };

  for (const t of snapshot?.tools ?? []) {
    if (!t?.callId || t.status === 'done') continue;
    // The slot's own status is the only truth here: `pending` is a call the
    // sequential round has not started, not one that is running.
    startTool(t.callId, t.name, undefined, t.status === 'running');
    const slot = state.tools.get(t.callId);
    if (slot && t.output) slot.out = t.output;
    if (slot && t.details?.conversationId !== undefined) slot.child = t.details.conversationId;
  }

  if (snapshot?.agent) set({ model: { ...(state.model ?? {}), ...(snapshot.agent.model ?? {}) } });
  if (snapshot?.usage) set({ usage: snapshot.usage });
  if (snapshot?.inbox) set({ inbox: snapshot.inbox });
  set({ busy: Boolean(snapshot?.run) });
}

// ── the frame watermark ──────────────────────────────────────────────────
// `bridgeSeq` counts the frames the bridge has written. Remembering the last one lets a
// reconnect say where it got to, and lets the bridge answer with `gapped`.
//
// The in-memory value is what a reconnect uses, so it moves on every frame. The
// stored one only has to survive a reload, and a synchronous storage write per
// streamed text delta is jank on the one path that cannot afford it.
let seqSave = null;
function rememberSeq(seq) {
  set({ lastSeq: seq });
  if (!seqSave) seqSave = setTimeout(flushSeq, 500);
}
function flushSeq() {
  if (seqSave) { clearTimeout(seqSave); seqSave = null; }
  store.set('pi-lastSeq', String(state.lastSeq));
}
// A WebView can be frozen and killed without another turn to write in.
try { window.addEventListener('pagehide', flushSeq); } catch {}

// ── events ───────────────────────────────────────────────────────────────
function handle(ev) {
  if (ev && typeof ev.bridgeSeq === 'number') rememberSeq(ev.bridgeSeq);
  // The server wraps the attach-time view in its OWN frame, and only later
  // batches arrive as pi-durable events. Without this the transcript is empty
  // on every load, every reconnect and every session switch.
  if (ev.type === 'bridge_snapshot') {
    renderSnapshot(ev.snapshot);
    if (ev.sessionName) set({ sessionName: ev.sessionName });
    // The context estimate rides on the FRAME, not inside the kernel's snapshot
    // (pi-durable's SnapshotEvent has no such field), and this frame is the
    // authoritative state after an attach: a session switch, a new session, or a
    // reconnect. Reading it off `ev.snapshot` left the old session's number on
    // the context bar until something else happened to refetch /api/state.
    if (typeof ev.contextTokens === 'number') set({ contextTokens: ev.contextTokens });
    if (typeof ev.contextWindow === 'number') set({ model: { ...(state.model ?? {}), contextWindow: ev.contextWindow } });
    // `gapped` means frames were written while this client was away. The snapshot
    // in this same frame is the whole state, so nothing was lost: this is a note
    // that the transcript was rebuilt, not a warning about missing data.
    if (ev.gapped) sys('reconnected', 'warn');
    redraw();
    return;
  }
  if (ev.type === 'bridge_error') {
    sys(`error: ${ev.error}`);
    redraw();
    return;
  }
  if (ev.type === 'bridge_extensions') {
    // The proposals changed: the agent proposed something, or the user
    // installed or refused it.
    refreshExtensions().then(() => redraw());
    return;
  }
  if (ev.type === 'bridge_connected') {
    // The counter starts at zero with the bridge process, while the stored
    // watermark outlives it. A number from another run says nothing about this
    // one, so it is replaced instead of compared -- this frame is already the
    // first number of the new run.
    if (ev.epoch && ev.epoch !== state.epoch) {
      set({ epoch: ev.epoch });
      store.set('pi-epoch', ev.epoch);
    }
    return;
  }
  switch (ev.type) {
    case 'snapshot': renderSnapshot(ev); break;
    case 'run_start': set({ busy: true }); break;
    case 'run_end':
      set({ busy: false, live: null });
      // The context estimate is the kernel's, not something the deltas carry, so
      // it is refetched when a turn ends -- otherwise the bar sits at whatever it
      // showed when the page loaded, and every turn makes that more wrong.
      refreshState().catch(() => {});
      break;

    case 'message_start':
      if (ev.message?.role === 'assistant') set({ live: { text: textOf(ev.message), think: thinkingSegments(ev.message) } });
      break;
    case 'message_update': {
      const live = state.live ?? { text: '', think: [] };
      let text = live.text ?? '';
      let think = [...(live.think ?? [])];
      for (const c of ev.changes ?? []) {
        if (c.type === 'text_delta') text += c.delta;
        // A thinking block is empty when it starts and grows only through its
        // deltas — except redacted thinking, which is whole at start.
        else if (c.type === 'thinking_delta') think[c.contentIndex] = (think[c.contentIndex] ?? '') + c.delta;
        else if (c.type === 'thinking_start') {
          if (c.block?.thinking?.trim()) think[c.contentIndex] = c.block.thinking;
        } else if (c.type === 'message') {
          text = textOf(c.message);
          think = thinkingSegments(c.message);
        }
      }
      set({ live: { text, think } });
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
      const result = ev.entry?.model?.find((m) => m?.role === 'toolResult');
      const failed = !result || result.isError;
      if (t) {
        t.status = failed ? 'err' : 'done';
        t.out = textOf(result);
      }
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
//
// The browser retries a dropped stream with the URL it was given, which would keep
// asking about the watermark this page loaded with. So the retry is made here,
// with the watermark the client has now.
let live = null;
let retryTimer = null;
let retryMs = 500;
function subscribe() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const since = state.lastSeq > 0 ? `&since=${encodeURIComponent(state.lastSeq)}` : '';
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}${since}`);
  live = source;
  source.onmessage = (m) => {
    try { handle(JSON.parse(m.data)); } catch { /* a malformed frame is not worth crashing over */ }
  };
  source.onerror = () => {
    if (live !== source) return;
    live = null;
    set({ error: 'lost the connection — retrying' });
    redraw();
    try { source.close(); } catch {}
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, 15000);
    retryTimer = setTimeout(() => { retryTimer = null; if (!live) subscribe(); }, wait);
  };
  source.onopen = () => {
    retryMs = 500;
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
      thinkingLevel: s.thinkingLevel ?? 'off',
      // The menu shows the thinking level, so it has to be here and not fetched
      // by the sheet that displays it.
      thinking: { ...state.thinking, level: s.thinkingLevel ?? state.thinking.level ?? 'off' },
      busy: Boolean(s.busy),
      usage: s.usage ?? null,
      contextTokens: s.contextTokens ?? state.contextTokens ?? 0,
      // The inbox arrives as the pi.inbox DOCUMENT, whose shape is {items:[...]}.
      inbox: s.inbox?.items ?? (Array.isArray(s.inbox) ? s.inbox : []),
  sessionName: s.sessionName ?? 'Main',
      // The id is what the sessions sheet marks as current. Matching on the name
      // was wrong: sessions created without one all report 'Main'.
      sessionId: s.sessionId ?? null,
      error: null,
    });
  } catch (e) {
    set({ error: String(e.message || e) });
  }
  // The provider count is a menu hint, so it is fetched at boot rather than when
  // the provider sheet happens to be opened.
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
  const optimistic = { kind: 'user', text: body, pending: true };
  state.entries.push(optimistic);
  state.pending.push({ text: body, entry: optimistic });
  set({ live: null });
  redraw();
  try {
    await post('/api/prompt', {
      message: body,
      requestId: requestId(),
      // Always steer. A message sent while the agent is working joins that
      // work at the end of the current tool round, instead of waiting for the
      // run to answer and starting a new one. There is no "send it later"
      // switch; the stop button is how a run that went the wrong way ends.
      whenBusy: 'steer',
    });
  } catch (e) {
    const i = state.pending.findIndex((p) => p.text === body);
    if (i >= 0) {
      // The optimistic ENTRY, not the last entry: between the push and the POST
      // resolving, an arriving message can be the last one, and then the wrong
      // bubble turns red.
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
  // A sheet is an overlay, not a navigation, so without this the Android back
  // button exits the app with a sheet open. Pushing a history entry lets the
  // WebView's own back handling fire popstate, which closes it.
  if (state.sheet === null && typeof history.pushState === 'function') {
    try { history.pushState({ sheet: which }, ''); } catch { /* a file:// page may refuse */ }
  }
  if (state.sheet !== 'oauth' && state.oauth) state.oauth = null;
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
    } else if (which === 'menu') {
      // The menu shows which pi is installed, so it has to know before it paints.
      await refreshPi();
    } else if (which === 'extensions') {
      await refreshExtensions();
    }
  } catch (e) {
    set({ notice: String(e.message || e) });
  }
  redraw();
}

async function saveKey(key) {
  if (!state.addKeyFor) return;
  try {
    const provider = state.addKeyFor;
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
    // Stop when the sheet is closed: the server keeps the login alive for ten
    // minutes, and there is no reason to keep asking about it once the user
    // has walked away.
    if (!o || o.done || state.sheet !== 'oauth') { if (state.sheet !== 'oauth') state.oauth = null; return; }
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

// ── the install gate ─────────────────────────────────────────────────────
// The agent writes an extension and proposes it. The file, its hash and its
// diff are shown here, and nothing runs until the user taps Install. The
// hash that is sent is the one that was shown: if the file changed in the
// meantime, the server refuses it.

async function refreshExtensions() {
  try {
    const r = await get('/api/extensions');
    set({ extensions: { installed: r.installed ?? [], proposals: r.proposals ?? [], problems: r.problems ?? [] } });
    return true;
  } catch {
    return false;
  }
}

const pendingProposals = () => (state.extensions?.proposals ?? [])
  .filter((p) => p.state === 'pending' || p.state === 'changed');

async function installExtension(p) {
  try {
    await post('/api/extensions/install', { key: p.key, hash: p.hash });
    set({ notice: `${p.key} installed` });
  } catch (e) {
    set({ notice: String(e.message || e) });
  }
  await refreshExtensions();
  redraw();
}

async function rejectExtension(p) {
  try {
    await post('/api/extensions/reject', { key: p.key, hash: p.hash });
    set({ notice: `${p.key} refused` });
  } catch (e) {
    set({ notice: String(e.message || e) });
  }
  await refreshExtensions();
  redraw();
}

async function uninstallExtension(p) {
  try {
    await post('/api/extensions/uninstall', { key: p.key });
    set({ notice: `${p.key} removed` });
  } catch (e) {
    set({ notice: String(e.message || e) });
  }
  await refreshExtensions();
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
      <span>${label}</span>
      ${queued && !state.busy ? html`<span>· ${queued} waiting</span>` : null}
    </div>`;
}

// Tool calls use the same quiet, collapsed disclosure as Thoughts: a one-line
// summary and a body behind a left rule. The output stays monospace, because
// it is command output rather than prose.
function Tool({ t }) {
  const running = t.status === 'run';
  const failed = t.status === 'err';
  const queued = t.status === 'queued';
  const out = String(t.out ?? '');
  const brief = t.child !== undefined ? `subagent #${t.child}` : t.brief;
  const meta = running ? 'running…' : queued ? 'queued' : failed ? 'failed' : out ? `${out.length.toLocaleString()} chars` : 'done';
  return html`
    <details class=${`thoughts tool${running ? ' live' : ''}${queued ? ' queued' : ''}${failed ? ' err' : ''}`}>
      <summary>
        <span class="caret">▶</span>
        <span class="name">${t.name}</span>
        ${brief ? html`<span class="brief">${brief}</span>` : null}
        <span class="meta">${meta}</span>
      </summary>
      <div class="think-body">
        ${out
          ? html`<pre>${out}</pre>`
          : html`<div class="tool-empty">${running ? 'Running…' : queued ? 'Waiting to run…' : 'No output'}</div>`}
      </div>
    </details>`;
}

// Collapsed by default: `open` is never passed, so Preact leaves the attribute
// alone and the browser keeps whatever the reader chose across redraws.
function Thoughts({ text, live }) {
  return html`
    <details class=${`thoughts${live ? ' live' : ''}`}>
      <summary>
        <span class="caret">▶</span>
        <span class="name">Thoughts</span>
        <span class="meta">${live ? 'thinking…' : `${text.length.toLocaleString()} chars`}</span>
      </summary>
      <div class="think-body md">${markdown(text)}</div>
    </details>`;
}

function Message({ m, idx }) {
  if (m.kind === 'sys') return html`<div class=${`sys ${m.tone || ''}`}>${m.text}</div>`;
  if (m.kind === 'tool') return html`<div class=${`thoughts tool ${m.tone === 'bad' ? 'err' : ''}`}><div class="think-body"><pre>${m.text}</pre></div></div>`;
  if (m.kind === 'user') {
    return html`<div class=${`msg user ${m.pending ? 'pending' : ''} ${m.tone === 'bad' ? 'failed' : ''}`}>
      <div class="body">${m.text}</div>
    </div>`;
  }
  const msgKey = `a${idx}`;
  const text = (m.blocks ?? []).filter((b) => b.type !== 'tool').map((b) => b.text).join('\n\n');
  const copied = state.copied.has(msgKey);
  return html`<div class="msg assistant">
    ${m.thinking ? html`<${Thoughts} text=${m.thinking} />` : null}
    ${(m.blocks ?? []).map((b, i) => {
      if (b.type === 'tool') {
        const t = state.tools.get(b.id);
        return t ? html`<${Tool} key=${`b${i}-${b.id}`} t=${t} />` : null;
      }
      return html`<div class="body md" key=${`b${i}`}>${markdown(b.text)}</div>`;
    })}
    ${text ? html`<button class="copy-btn" aria-label="Copy" onClick=${() => copyResponse(msgKey, text)}>${copied ? html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>` : html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`}</button>` : null}
  </div>`;
}

function Transcript() {
  const items = [];
  for (let i = 0; i < state.entries.length; i++) { const m = state.entries[i]; items.push(html`<${Message} key=${`e${i}`} m=${m} idx=${i} />`); }
  // Normally every tool sits inside the assistant turn that called it. A tool
  // that starts before that turn is committed is still shown at the end until
  // the history arrives and takes it over.
  for (const [id, t] of state.tools) {
    if (state.attachedTools.has(id)) continue;
    items.push(html`<${Tool} key=${`t${id}`} t=${t} />`);
  }
  if (state.live) {
    const think = thoughtsText(state.live.think);
    items.push(html`<div class="msg assistant live" key="live">
      ${think ? html`<${Thoughts} text=${think} live=${true} />` : null}
      ${state.live.text ? html`<div class="body md">${markdown(state.live.text)}</div>` : null}
    </div>`);
  }
  return html`<div class="log" id="log">${items}</div>`;
}

function BottomBar() {
  const level = state.thinking?.level ?? 'off';
  const levelLabel = level === 'off' ? 'off' : (level[0].toUpperCase() + level.slice(1));
  const cache = cacheHitRate(state.usage, state.model);
  const cost = sessionCost(state.usage);
  const maxCtx = state.model?.contextWindow ?? (state.models || []).find((m) => m.provider === state.model?.provider && m.modelId === (state.model?.modelId ?? state.model?.id))?.contextWindow ?? 128000;
  const used = state.contextTokens ?? 0;
  const pct = maxCtx ? Math.min(100, Math.round(used / maxCtx * 100)) : 0;
  return html`
    <div class="bottombar">
      <div class="bottombar-top">
        <div class="bottombar-left">
          <button class="bottombar-item" onClick=${() => openSheet('model')} aria-label="Model">${modelShort(state.model)}</button>
          <span class="bottombar-dot">·</span>
          <button class="bottombar-item" onClick=${() => openSheet('thinking')} aria-label="Thinking level">${levelLabel}</button>
        </div>
        <div class="bottombar-right">
          <span class="bottombar-item">chr ${cache}</span>
          <span class="bottombar-dot">·</span>
          <span class="bottombar-item">${cost}</span>
        </div>
      </div>
      <div class="context-row">
        <div class="context-bar"><div class="context-fill" style="width: ${pct}%"></div></div>
        <button class="context-label" onClick=${() => toggleContextFormat()}>${contextLabel(used, maxCtx)}</button>
      </div>
    </div>`;
}

let contextShowNumbers = false;
function toggleContextFormat() { contextShowNumbers = !contextShowNumbers; redraw(); }
function contextLabel(used, max) {
  if (contextShowNumbers) return `${used.toLocaleString()} / ${max.toLocaleString()}`;
  const pct = max ? Math.min(100, Math.round(used / max * 100)) : 0;
  return `${pct}%`;
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

/** An OAuth event is an object ({type, url}, {type, userCode}, ...), not a string. */
function eventText(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (e.type === 'auth_url') return e.url ?? '';
  if (e.type === 'device_code') return `code: ${e.userCode ?? e.code ?? ''}`;
  if (e.type === 'message') return e.message ?? '';
  return e.message ?? e.text ?? JSON.stringify(e);
}

function closeSheet() {
  if (state.sheet !== null && typeof history.back === 'function') {
    try { history.back(); return; } catch { /* fall through */ }
  }
  set({ sheet: null });
  redraw();
}

function Scrim() {
  return html`<div class="scrim" onClick=${closeSheet}></div>`;
}

// ── pi itself ────────────────────────────────
async function refreshPi() {
  try {
    set({ pi: await get('/api/pi-update') });
  } catch {
    // The bridge is restarting to load what was just installed: there is nobody
    // to ask right now, and the reconnect will bring the new version.
  }
}

/**
 * Ask for an update, then follow it until it stops moving.
 *
 * The bridge answers at once (`started`) and does the install in the background,
 * so the outcome has to be polled -- that is the whole reason this used to look
 * like it did nothing: the tap set a one-line notice, the menu never rendered it,
 * and the install's only visible effect was a restart.
 */
async function updatePi() {
  try {
    const r = await post('/api/pi-update');
    if (r.started === false) { set({ notice: r.reason || 'an update is already running' }); redraw(); return; }
  } catch (e) {
    set({ notice: String(e.message || e) });
    redraw();
    return;
  }
  set({ pi: { ...(state.pi ?? {}), running: true, done: false, ok: false, error: null, log: [], startedFrom: state.pi?.installed ?? null }, notice: null });
  redraw();
  for (let i = 0; i < 600; i++) {                       // npm takes seconds, not minutes
    await new Promise((r) => setTimeout(r, 500));
    try {
      const s = await get('/api/pi-update');
      set({ pi: { ...s, startedFrom: state.pi?.startedFrom ?? null } });
      redraw();
      if (!s.running) return;
    } catch {
      // A restart is the success path: the bridge exits to load the new modules.
      set({ pi: { ...(state.pi ?? {}), running: false, done: true, ok: true, restarting: true } });
      redraw();
      return;
    }
  }
}

function piHint() {
  const pi = state.pi;
  if (!pi) return '';
  if (pi.running) return 'updating…';
  if (pi.restarting) return 'bridge restarted';
  if (pi.error) return 'failed';
  if (pi.done && pi.ok && pi.changed) return `updated to ${pi.version}`;
  if (pi.done && pi.ok) return `up to date (${pi.installed ?? pi.version ?? '?'})`;
  return pi.installed ? `v${pi.installed}` : '';
}

function MenuSheet() {
  const level = state.thinking?.level ?? 'off';
  const pending = pendingProposals().length;
  const items = [
    { label: 'Model', hint: modelLabel(state.model), go: () => openSheet('model') },
    { label: 'Thinking', hint: level === 'off' ? 'off' : level[0].toUpperCase() + level.slice(1), go: () => openSheet('thinking') },
    { label: 'Provider', hint: state.providers?.length ? `${state.providers.length} key${state.providers.length > 1 ? 's' : ''}` : 'not set', go: () => openSheet('provider') },
    { label: 'Sessions', hint: state.sessionName, go: () => openSheet('sessions') },
    { label: 'Usage', hint: usageShort(state.usage), go: () => openSheet('usage') },
    { label: 'Extensions', hint: pending ? `${pending} to review` : (state.extensions?.installed?.length ? `${state.extensions.installed.length} installed` : 'none'), go: () => openSheet('extensions') },
  ];
  return html`
    <div class="sheet">
      <div class="grab"></div>
      <header><h2>pi</h2>
        <button class="icon" onClick=${() => { set({ sheet: null }); redraw(); }} aria-label="Close">✕</button>
      </header>
      <div class="body">
        ${items.map((it) => html`
          <button class="row" key=${it.label} onClick=${it.go}>
            <span class="grow">${it.label}</span>
            <small>${it.hint}</small>
          </button>`)}
        <button class="row" onClick=${async () => { await post('/api/sessions/new').catch(() => {}); await refreshState().catch(() => {}); set({ sheet: null }); redraw(); }}>
          <span class="grow">New session</span>
        </button>
        <button class="row" onClick=${async () => { await post('/api/new').catch(() => {}); await refreshState().catch(() => {}); set({ sheet: null }); redraw(); }}>
          <span class="grow">Reset this conversation</span>
        </button>
        <button class="row" onClick=${async () => { await post('/api/compact').catch(() => {}); set({ sheet: null }); redraw(); }}>
          <span class="grow">Compact context</span>
        </button>
        <button class="row" onClick=${() => updatePi()}>
          <span class="grow">Update pi</span>
          <small>${piHint()}</small>
        </button>
        ${state.pi?.error ? html`<div class="row"><span class="grow pi-error">${state.pi.error}</span></div>` : null}
        ${state.pi?.log?.length ? html`<pre class="pi-log">${state.pi.log.slice(-8).join('\n')}</pre>` : null}
        ${state.notice ? html`<div class="row"><span class="grow">${state.notice}</span></div>` : null}
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
        <button class="icon" onClick=${() => { set({ sheet: null }); redraw(); }} aria-label="Close">✕</button>
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
        <button class="icon" onClick=${() => { set({ sheet: null }); redraw(); }} aria-label="Close">✕</button>
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
        <button class="icon" onClick=${() => { set({ sheet: null }); redraw(); }} aria-label="Close">✕</button>
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
        <button class="icon" onClick=${() => { set({ sheet: null }); redraw(); }} aria-label="Close">✕</button>
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

// The diff the user approves: what the file would become, line by line.
function DiffBlock({ text }) {
  const lines = String(text ?? '').split('\n');
  if (!lines.length) return null;
  return html`
    <pre class="diff">${lines.map((l, i) => html`
      <div key=${i} class=${l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : 'ctx'}>${l || ' '}</div>`)}</pre>`;
}

function ExtensionsSheet() {
  const installed = state.extensions?.installed ?? [];
  const proposals = state.extensions?.proposals ?? [];
  const problems = state.extensions?.problems ?? [];
  const waiting = proposals.filter((p) => p.state === 'pending' || p.state === 'changed' || p.state === 'failed');
  const refused = proposals.filter((p) => p.state === 'rejected');
  const label = (p) => ({
    pending: 'new extension',
    changed: 'changed since it was installed',
    failed: 'does not install',
    installed: 'installed',
    rejected: 'refused',
  })[p.state] ?? p.state;
  return html`
    <div class="sheet">
      <div class="grab"></div>
      <header>
        <button class="icon" onClick=${() => openSheet('menu')} aria-label="Back">‹</button>
        <h2>Extensions</h2>
        <button class="icon" onClick=${() => { set({ sheet: null }); redraw(); }} aria-label="Close">✕</button>
      </header>
      <div class="body">
        ${state.notice ? html`<div class="row"><span class="grow">${state.notice}</span></div>` : null}
        ${problems.length ? html`
          <div class="row"><span class="grow" style="color:var(--muted);font-size:12px">Problems</span></div>
          ${problems.map((p) => html`
            <div class="row" key=${'p-' + p.key}>
              <span class="grow">${p.key}<br /><small style="color:var(--bad)">${p.error}</small></span>
            </div>`)}` : null}
        <div class="row"><span class="grow" style="color:var(--muted);font-size:12px">Waiting for you</span></div>
        ${waiting.length ? waiting.map((p) => html`
          <div class="proposal" key=${p.key}>
            <div class="row">
              <span class="grow">${p.key}</span>
              <small>sha256 ${String(p.hash ?? '').slice(0, 12)}</small>
            </div>
            <div class="row">
              <span class="grow" style="color:var(--muted);font-size:12.5px">
                ${label(p)} · ${(p.bytes ?? 0).toLocaleString()} bytes
              </span>
            </div>
            ${p.error ? html`<div class="row"><span class="grow" style="color:var(--bad);font-size:12.5px">${p.error}</span></div>` : null}
            <${DiffBlock} text=${p.diff} />
            <details class="whole">
              <summary>the whole file</summary>
              <pre class="diff">${p.content ?? ''}</pre>
            </details>
            <div class="actions">
              <button class="act primary" onClick=${() => installExtension(p)}>Install</button>
              <button class="act" onClick=${() => rejectExtension(p)}>Refuse</button>
            </div>
          </div>`) : html`<div class="empty">Nothing to review.</div>`}
        ${refused.length ? html`
          <div class="row"><span class="grow" style="color:var(--muted);font-size:12px">Refused</span></div>
          ${refused.map((p) => html`
            <div class="row" key=${'r-' + p.key}>
              <span class="grow">${p.key}</span>
              <small>sha256 ${String(p.hash ?? '').slice(0, 12)}</small>
            </div>`)}` : null}
        <div class="row"><span class="grow" style="color:var(--muted);font-size:12px">Installed</span></div>
        ${installed.length ? installed.map((e) => html`
          <div class="row" key=${'i-' + e.key}>
            <span class="grow">${e.name ?? e.key}<br /><small>${e.key} · sha256 ${String(e.hash ?? '').slice(0, 12)}</small></span>
            <button class="act" onClick=${() => uninstallExtension(e)}>Remove</button>
          </div>`) : html`<div class="empty">No extensions installed.</div>`}
        <div class="row"><span class="grow" style="color:var(--muted);font-size:12px">What this is</span></div>
        <div class="row" style="display:block;color:var(--muted);font-size:12.5px">
          An extension the agent wrote runs inside the bridge process, with the
          bridge's permissions. The file, its hash and this diff are what you
          approve; the hash is what the bridge checks, so a file that changed
          since is refused.
        </div>
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
  if (which === 'extensions') return html`<${Scrim} /><${ExtensionsSheet} />`;
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
            <span class="grow">${s.name ?? id}${String(s.id) === String(state.sessionId) ? ' ·' : ''}</span>
            ${s.cwd ? html`<small>${s.cwd}</small>` : null}
          </button>`;
        })
      : html`<div class="empty">No sessions yet.</div>`;
  } else {
    // /api/usage returns {session, total}; the session usage has the same shape
    // as /api/state's.
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
        <button class="icon" aria-label="Menu" onClick=${() => openSheet('menu')}>☰</button>
      </div>
      <${StatusStrip} />
    </div>
    <${Transcript} />
    <${Composer} />
    <${BottomBar} />
    <${Sheet} />`;
}

async function copyResponse(key, text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  } catch {}
  state.copied.add(key);
  redraw();
  setTimeout(() => { state.copied.delete(key); redraw(); }, 1500);
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

function cacheHitRate(usage, model) {
  const key = model ? `${model.provider}/${model.modelId ?? model.id ?? model.model}` : '';
  const u = usage?.models?.[key];
  if (!u) return '–';
  const denom = (u.input || 0) + (u.cacheRead || 0);
  if (!denom) return '–';
  return `${Math.round((u.cacheRead || 0) / denom * 100)}%`;
}

function sessionCost(usage) {
  let cost = 0;
  for (const u of Object.values(usage?.models ?? {})) cost += u?.cost?.total || 0;
  return '$' + cost.toFixed(3);
}

function modelShort(model) {
  if (!model) return '–';
  const s = typeof model === "string" ? model : (model.modelId ?? model.id ?? model.model ?? "");
  return String(s).split('/').pop().slice(0, 12) || '–';
}

// ── keep the transcript pinned to the bottom while it grows ──────────────
// Whether the view was at the bottom BEFORE the DOM changed. Measuring afterwards
// means one tall frame (a snapshot, a long answer) puts the distance over the
// threshold and the view stops following -- permanently.
let wasAtBottom = true;
function stickToBottom() {
  const log = doc.getElementById('log');
  if (!log) return;
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
}
function rememberScroll() {
  const log = doc.getElementById('log');
  if (!log) return;
  wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
}

// ── boot ─────────────────────────────────────────────────────────────────
// index.html ships a static `.boot` placeholder inside #app. Preact appends to
// its container rather than replacing it, so the placeholder would survive
// every render as a stray line below the composer. Drop it once, before the
// first render; subsequent redraws diff against the tree Preact owns.
doc.getElementById('app').replaceChildren();
subscribe();
refreshState();
refreshExtensions();
redraw();

// The client, driven with the server's ACTUAL frames.
//
// The rewrite of the client re-derived the server's wire format from memory and got it wrong in
// several places -- the worst being that the attach-time frame, `bridge_snapshot`, was not handled
// at all, so the transcript was empty on every load. These tests exist so that a mismatch between
// the client and the server is a failing test rather than a blank screen.
//
// They mount the real runtime/public/app.js in a DOM, feed it the frames the server really sends
// (see runtime/server.mjs: `bridge_connected`, `bridge_snapshot`, then the pi-durable events), and
// assert on what the user would see.
//
//   node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const PUBLIC = new URL('../runtime/public/', import.meta.url);

/** Mount the client in a fresh DOM and return the handles the test needs. */
async function mount({ state = {}, models = [], providers = [], oauthProviders = [], usage = {} } = {}) {
  const { window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>');
  const { document } = window;

  let source = null;
  const fetches = [];

  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = new URL('http://127.0.0.1:8787/?token=test-token');
  globalThis.history = { replaceState: () => {}, pushState: () => {}, back: () => {} };
  globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.get(k) ?? null; },
    setItem(k, v) { this._m.set(k, v); },
  };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.EventSource = class {
    constructor(url) { this.url = url; source = this; }
    close() {}
  };
  globalThis.fetch = async (url, opts) => {
    fetches.push([String(url), opts]);
    const u = String(url);
    const body = u.includes('/api/state') ? state
      : u.includes('/api/models') ? { models }
      : u.includes('/api/providers') ? { providers, catalog: [] }
      : u.includes('/api/oauth/providers') ? { providers: oauthProviders }
      // The client polls this until it says done; a mock that never does would poll forever.
      : u.includes('/api/oauth/status') ? { done: true, events: [], prompt: null }
      : u.includes('/api/oauth/start') ? { id: 'login-1' }
      : u.includes('/api/usage') ? usage
      : {};
    return { ok: true, status: 200, json: async () => body };
  };

  // A fresh module instance per test, so the module-level state does not leak between them.
  await import(`${PUBLIC}app.js?v=${Math.random()}`);
  await new Promise((r) => setTimeout(r, 30));

  return {
    document,
    fetches,
    send(ev) { source.onmessage({ data: JSON.stringify(ev) }); },
    sendMany(evs) { for (const ev of evs) source.onmessage({ data: JSON.stringify(ev) }); },
    async settle() { await new Promise((r) => setTimeout(r, 30)); },
    text() { return document.getElementById('app').textContent.replace(/\s+/g, ' ').trim(); },
    html() { return document.getElementById('app').innerHTML; },
  };
}

test('the attach-time frame renders the conversation', async () => {
  // The server sends this FIRST, on every attach: runtime/server.mjs sends {type:'bridge_snapshot', snapshot, ...}.
  // If the client does not handle it, the transcript is empty until the agent happens to say something.
  const app = await mount();
  app.send({
    type: 'bridge_snapshot',
    sessionId: '7',
    sessionName: 'Main',
    snapshot: {
      entries: [
        { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'what did the build say' }] },
        { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'it said hello' }] }] },
      ],
      agent: { model: 'anthropic/claude-sonnet-4' },
      usage: null,
      inbox: [],
      run: null,
    },
  });
  await app.settle();
  assert.match(app.text(), /what did the build say/, 'the user message from the snapshot is missing');
  assert.match(app.text(), /it said hello/, 'the assistant message from the snapshot is missing');
});

test('a bridge error is shown', async () => {
  const app = await mount();
  app.send({ type: 'bridge_error', error: 'the harness is not ready' });
  await app.settle();
  assert.match(app.text(), /the harness is not ready/);
});

test('a confirmed message stops looking pending', async () => {
  const app = await mount();
  app.send({ type: 'bridge_snapshot', sessionName: 'Main', snapshot: { entries: [], run: null } });
  await app.settle();

  // Send one, so the optimistic bubble really exists: an earlier version of this
  // test never sent anything and so passed without testing anything.
  const ta = app.document.querySelector('textarea');
  ta.value = 'hello';
  await app.document.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await app.settle();
  assert.match(app.html(), /msg user pending/, 'the optimistic message is not shown as pending');

  // ...and the committed entry clears the flag.
  app.send({ type: 'message_end', entry: { id: 9, model: [{ role: 'user', content: 'hello' }] } });
  await app.settle();
  assert.doesNotMatch(app.html(), /msg user pending/, 'the message is still marked pending after it was confirmed');
});

test('the composer keeps its draft when the agent starts and stops', async () => {
  const app = await mount();
  const ta = app.document.querySelector('textarea');
  ta.value = 'half a thought';
  // The "send as" row appears and disappears as the agent's state changes. If the form's children
  // change shape, the textarea is recreated and the draft is lost.
  app.send({ type: 'run_start' });
  await app.settle();
  app.send({ type: 'run_end' });
  await app.settle();
  const after = app.document.querySelector('textarea');
  assert.equal(after.value, 'half a thought', 'the draft was lost across a busy toggle');
});

test('a failed tool call is shown, and marked failed', async () => {
  const app = await mount();
  app.send({ type: 'bridge_snapshot', sessionName: 'Main', snapshot: { entries: [], run: null } });
  await app.settle();
  app.send({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.txt' } });
  await app.settle();
  app.send({ type: 'tool_execution_end', toolCallId: 'c1', entry: { id: 3, model: [{ role: 'toolResult', isError: true, toolName: 'read' }] } });
  await app.settle();
  const details = app.document.querySelector('details');
  assert.ok(details, 'the tool call is not in the transcript');
  assert.match(details.getAttribute('class') ?? '', /err/, 'a failed tool call is not marked failed');
  assert.match(app.text(), /failed/, 'the failure is not in the summary');
});

test('an OAuth device code is shown, not [object Object]', async () => {
  const app = await mount({ oauthProviders: [{ id: 'anthropic', name: 'Anthropic', label: 'Claude Pro/Max' }] });
  app.send({ type: 'bridge_snapshot', sessionName: 'Main', snapshot: { entries: [], run: null } });
  await app.settle();
  // Open the provider sheet, then the OAuth sheet.
  const menu = [...app.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Menu');
  menu.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const provider = [...app.document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Provider'));
  provider.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const signIn = [...app.document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Claude Pro/Max'));
  assert.ok(signIn, 'the OAuth provider is not offered');
  signIn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  assert.doesNotMatch(app.text(), /\[object Object\]/, 'an OAuth event was rendered as [object Object]');
});

test('prose after a code fence is prose, not code', async () => {
  const app = await mount();
  app.send({ type: 'bridge_snapshot', sessionName: 'Main', snapshot: { entries: [], run: null } });
  await app.settle();
  app.send({
    type: 'message_end',
    entry: { id: 11, model: [{ role: 'assistant', content: [{ type: 'text', text: 'Here is code:\n\n```js\nconsole.log(1)\n```\n\nAnd here is prose after the fence.' }] }] },
  });
  await app.settle();
  const body = app.document.querySelector('.msg.assistant .body');
  assert.ok(body, 'the assistant message is not in the transcript');
  // The split alternates prose and code; treating every block after the first as code put the prose
  // after the fence inside a <pre>.
  assert.equal(body.querySelectorAll('pre').length, 1, 'the prose after the fence was rendered as code');
  assert.match(body.textContent, /And here is prose after the fence\./);
});

test('a tool call sits under the turn that called it', async () => {
  const app = await mount();
  app.send({ type: 'bridge_snapshot', sessionName: 'Main', snapshot: { entries: [], run: null } });
  await app.settle();

  // An assistant turn that CALLS a tool: the tool chip belongs to that turn, not
  // in a block of its own at the bottom of the transcript.
  app.send({
    type: 'message_end',
    entry: {
      id: 20,
      model: [{ role: 'assistant', content: [
        { type: 'text', text: 'let me look' },
        { type: 'toolCall', id: 'c9', name: 'read', arguments: { path: 'x' } },
      ] }],
    },
  });
  await app.settle();
  app.send({ type: 'tool_execution_start', toolCallId: 'c9', toolName: 'read', args: { path: 'x' } });
  await app.settle();

  const rows = [...app.document.querySelectorAll('.log > *')];
  assert.ok(rows.length >= 1, 'the transcript is empty');
  // The tool is inside the assistant turn's own row, not a separate block.
  const withTool = rows.find((r) => (r.textContent ?? '').includes('read'));
  assert.ok(withTool, 'the tool call is not in the transcript');
  assert.match(withTool.textContent, /let me look/, 'the tool chip is not under the turn that called it');
});

test('the menu shows the thinking level and the provider count without opening their sheets', async () => {
  const app = await mount({
    state: { model: { provider: 'anthropic', modelId: 'claude' }, thinkingLevel: 'high', busy: false, sessionName: 'Main' },
    providers: [{ provider: 'anthropic', type: 'api_key', keyHint: '…9f2a' }],
  });
  await app.settle();
  const menu = [...app.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Menu');
  menu.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  assert.match(app.text(), /High/, 'the menu does not show the thinking level it was told about');
  assert.match(app.text(), /1 key/, 'the menu does not show the provider count');
});

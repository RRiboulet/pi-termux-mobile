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
async function mount({
  state = {}, models = [], providers = [], oauthProviders = [], usage = {}, extensions = {},
  // What localStorage already holds, as a reload would find it.
  stored = {},
  // What /api/oauth/status answers, poll by poll. The last entry repeats, so a
  // login that never finishes needs one. A function is called with the poll
  // number, which is how a test makes the bridge fail.
  oauthStatus = [{ done: true, events: [], prompt: null }],
} = {}) {
  const { window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>');
  const { document } = window;

  let source = null;
  const sources = [];
  const fetches = [];
  let oauthPolls = 0;
  const nextOauthStatus = () => {
    const n = oauthPolls++;
    return typeof oauthStatus === 'function'
      ? oauthStatus(n)
      : oauthStatus[Math.min(n, oauthStatus.length - 1)];
  };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = new URL('http://127.0.0.1:8787/?token=test-token');
  globalThis.history = { replaceState: () => {}, pushState: () => {}, back: () => {} };
  globalThis.localStorage = {
    _m: new Map(Object.entries(stored)),
    getItem(k) { return this._m.get(k) ?? null; },
    setItem(k, v) { this._m.set(k, v); },
  };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.EventSource = class {
    constructor(url) { this.url = url; this.closed = false; source = this; sources.push(this); }
    close() { this.closed = true; }
  };
  globalThis.fetch = async (url, opts) => {
    fetches.push([String(url), opts]);
    const u = String(url);
    const body = u.includes('/api/state') ? state
      : u.includes('/api/models') ? { models }
      : u.includes('/api/providers') ? { providers, catalog: [] }
      : u.includes('/api/oauth/providers') ? { providers: oauthProviders }
      // The client polls this until it says done; a mock that never does would poll forever.
      : u.includes('/api/oauth/status') ? nextOauthStatus()
      : u.includes('/api/oauth/start') ? { id: 'login-1' }
      : u.includes('/api/usage') ? usage
      : u.includes('/api/extensions') ? extensions
      : {};
    return { ok: true, status: 200, json: async () => body };
  };

  // A fresh module instance per test, so the module-level state does not leak between them.
  await import(`${PUBLIC}app.js?v=${Math.random()}`);
  await new Promise((r) => setTimeout(r, 30));

  return {
    document,
    fetches,
    sources,
    stored: globalThis.localStorage._m,
    send(ev) { source.onmessage({ data: JSON.stringify(ev) }); },
    sendMany(evs) { for (const ev of evs) source.onmessage({ data: JSON.stringify(ev) }); },
    /** Drop the stream, and wait for the client's own retry to open the next one. */
    async reconnect() {
      const before = sources.length;
      source.onerror();
      const end = Date.now() + 3000;
      while (sources.length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      assert.ok(sources.length > before, 'the client did not reconnect');
    },
    async settle() { await new Promise((r) => setTimeout(r, 30)); },
    text() { return document.getElementById('app').textContent.replace(/\s+/g, ' ').trim(); },
    html() { return document.getElementById('app').innerHTML; },
  };
}

/**
 * The OAuth poll is a 1200ms timer, and the body of that timer is what this
 * file could not reach: waiting it out would make the suite slower *and* hand
 * it back the wall-clock race it was just cured of.
 *
 * So the timer is captured instead of waited for: `tick()` runs the callback
 * the client scheduled, and nothing else. Every other delay -- the frame
 * shim, `settle()`, the retry backoff -- is left to the platform.
 *
 * This is scoped to one test and undone by `restore()`. That is what makes it
 * different from the harness-wide `setTimeout` patch this file used to carry:
 * it drives the timer to reach code, rather than replacing the timer for every
 * test and silently clearing what a test meant to keep.
 */
const OAUTH_POLL_MS = 1200;
function pollClock() {
  const scheduled = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms !== OAUTH_POLL_MS) return realSetTimeout(fn, ms, ...rest);
    const timer = { fn, live: true };
    scheduled.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (id) => {
    // The client clears its previous poll before scheduling the next one.
    if (id && typeof id === 'object' && 'live' in id) { id.live = false; return; }
    realClearTimeout(id);
  };
  return {
    /** How many poll callbacks are waiting to run. */
    pending: () => scheduled.filter((t) => t.live).length,
    /** Run whatever the client has scheduled, and wait for it to settle. */
    async tick() {
      const live = scheduled.filter((t) => t.live);
      for (const t of live) { t.live = false; await t.fn(); }
      return live.length;
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

/** Menu -> Provider -> the OAuth provider. This opens the OAuth sheet. */
async function signIn(app) {
  const menu = [...app.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Menu');
  menu.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const provider = [...app.document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Provider'));
  provider.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const oauth = [...app.document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Claude Pro/Max'));
  assert.ok(oauth, 'the OAuth provider is not offered');
  oauth.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
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
  // The stop button appears and disappears as the agent's state changes. If the form's children
  // change shape, the textarea is recreated and the draft is lost.
  app.send({ type: 'run_start' });
  await app.settle();
  app.send({ type: 'run_end' });
  await app.settle();
  const after = app.document.querySelector('textarea');
  assert.equal(after.value, 'half a thought', 'the draft was lost across a busy toggle');
});

test('a message sent while busy steers the running work', async () => {
  // There is no send-as selector: a busy message always steers. A `whenBusy` of undefined would be
  // admitted as a followUp by pi-durable, and the message would sit in the inbox until the run
  // answered instead of joining it at the end of the tool round.
  const app = await mount();
  app.send({ type: 'bridge_snapshot', sessionName: 'Main', snapshot: { entries: [], run: null } });
  await app.settle();
  app.send({ type: 'run_start' });
  await app.settle();

  const ta = app.document.querySelector('textarea');
  ta.value = 'use the devcontainer instead';
  await app.document.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await app.settle();

  const prompt = app.fetches.find(([url]) => String(url).includes('/api/prompt'));
  assert.ok(prompt, 'no /api/prompt was sent');
  assert.equal(JSON.parse(prompt[1].body).whenBusy, 'steer',
    'a busy message must steer the running work, not queue behind it');

  const labels = Array.from(app.document.querySelectorAll('button')).map((b) => b.textContent.trim());
  assert.ok(!labels.includes('Steer') && !labels.includes('Queue'),
    `the send-as buttons are still rendered: ${labels.join(', ')}`);
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

const oauthProvider = [{ id: 'anthropic', name: 'Anthropic', label: 'Claude Pro/Max' }];

/** How many times the client asked the bridge about this login. */
const statusPolls = (app) => app.fetches.filter(([url]) => url.includes('/api/oauth/status')).length;

test('an OAuth device code is shown, not [object Object]', async () => {
  const clock = pollClock();
  try {
    const app = await mount({
      oauthProviders: oauthProvider,
      // The shape the bridge sends for a device-code login. The old client
      // rendered this event object as "[object Object]", which is the defect
      // this test is named for -- so it needs an event to render, and used to
      // be handed none.
      oauthStatus: [{
        done: false,
        prompt: null,
        events: [{ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://example.test/device' }],
      }],
    });
    app.send({ type: 'bridge_snapshot', sessionName: 'Main', snapshot: { entries: [], run: null } });
    await app.settle();
    await signIn(app);
    await clock.tick();
    await app.settle();
    assert.match(app.text(), /ABCD-1234/, 'the device code is not shown');
    assert.match(app.text(), /example\.test\/device/, 'where to enter the code is not shown');
    assert.doesNotMatch(app.text(), /\[object Object\]/, 'an OAuth event was rendered as [object Object]');
  } finally {
    clock.restore();
  }
});

test('the oauth poll asks the bridge again, and merges the events it gets', async () => {
  const clock = pollClock();
  try {
    const app = await mount({
      oauthProviders: oauthProvider,
      oauthStatus: [
        { done: false, events: [{ type: 'text', text: 'waiting for you' }], prompt: null },
        { done: true, events: [{ type: 'text', text: 'the provider said yes' }], prompt: null },
      ],
    });
    await signIn(app);
    assert.equal(clock.pending(), 1, 'starting a login did not schedule a poll');

    // A login that is not finished keeps asking, and shows what came back.
    assert.equal(await clock.tick(), 1);
    await app.settle();
    assert.match(app.text(), /waiting for you/, 'the first poll is not on the sheet');
    assert.equal(clock.pending(), 1, 'a login that is not done stopped polling');

    // The second answer finishes the login. The events accumulate: the sheet is
    // the login's history, and the bridge sends only what is new since the last
    // poll, so a merge that replaced would drop the device code mid-login.
    assert.equal(await clock.tick(), 1);
    await app.settle();
    assert.match(app.text(), /waiting for you/, 'the merge dropped an earlier event');
    assert.match(app.text(), /the provider said yes/, 'the last event is missing');
    assert.equal(clock.pending(), 0, 'a finished login kept polling');

    assert.equal(statusPolls(app), 2, `the bridge was asked ${statusPolls(app)} times`);
    assert.match(app.fetches.filter(([url]) => url.includes('/api/oauth/status'))[0][0], /id=login-1/,
      'the poll did not carry the login id');
  } finally {
    clock.restore();
  }
});

test('the oauth poll stops once the sheet is closed', async () => {
  const clock = pollClock();
  try {
    const app = await mount({
      oauthProviders: oauthProvider,
      oauthStatus: [{ done: false, events: [], prompt: null }],
    });
    await signIn(app);
    assert.equal(clock.pending(), 1, 'starting a login did not schedule a poll');

    // The user walks away. The server keeps the login alive for ten minutes, and
    // there is no reason to keep asking about it once nobody is looking.
    const close = [...app.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Close');
    assert.ok(close, 'the OAuth sheet has no close button');
    close.dispatchEvent(new window.Event('click', { bubbles: true }));
    await app.settle();
    const askedBefore = statusPolls(app);

    await clock.tick();
    await app.settle();
    assert.equal(statusPolls(app), askedBefore, 'a closed sheet kept polling');
    assert.equal(clock.pending(), 0, 'the poll scheduled another ask after the sheet closed');
  } finally {
    clock.restore();
  }
});

test('an oauth poll that fails says so, and does not keep asking', async () => {
  const clock = pollClock();
  try {
    const app = await mount({
      oauthProviders: oauthProvider,
      // The bridge went away between starting the login and the first poll.
      oauthStatus: () => { throw new Error('the bridge is gone'); },
    });
    await signIn(app);
    await clock.tick();
    await app.settle();
    assert.match(app.text(), /the bridge is gone/, 'the poll failed with nothing said about it');
    assert.equal(clock.pending(), 0, 'a failed poll kept asking');
  } finally {
    clock.restore();
  }
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

test('a turn keeps the order the message wrote its blocks in', async () => {
  const app = await mount();
  app.send({ type: 'bridge_snapshot', sessionName: 'Main', snapshot: { entries: [], run: null } });
  await app.settle();

  // What the model actually sends: the sentence, the call it makes, then the
  // sentence after it. This is not a contrived order -- one session on this
  // phone had 33 messages shaped [thinking, text, toolCall]. Rendering every
  // tool above the text put the running tool above the line that introduced
  // it, and a turn that says something after the call read backwards.
  app.send({
    type: 'message_end',
    entry: {
      id: 21,
      model: [{ role: 'assistant', content: [
        { type: 'text', text: 'before the call' },
        { type: 'toolCall', id: 'c21', name: 'bash', arguments: { command: 'ls' } },
        { type: 'text', text: 'after the call' },
      ] }],
    },
  });
  await app.settle();
  app.send({ type: 'tool_execution_start', toolCallId: 'c21', toolName: 'bash', args: { command: 'ls' } });
  await app.settle();

  const turn = app.document.querySelector('.msg.assistant');
  assert.ok(turn, 'the assistant turn is not in the transcript');
  const order = [...turn.children]
    .filter((el) => !el.classList.contains('copy-btn'))
    .map((el) => (el.matches('details.tool') ? 'tool'
      : String(el.className).includes('body') ? 'text'
      : el.tagName.toLowerCase()));
  assert.deepEqual(order, ['text', 'tool', 'text'],
    'the turn did not keep the order its blocks were written in');
});

test('a call the harness has not started yet is queued, not running', async () => {
  const app = await mount();
  app.send({ type: 'bridge_snapshot', sessionName: 'Main', snapshot: { entries: [], run: null } });
  await app.settle();
  app.send({ type: 'run_start' });
  await app.settle();

  // The harness commits the message -- both calls in it -- before it starts
  // either tool, and it runs them one at a time. Both were called "running…"
  // the moment they were committed, and the status strip named the first one
  // as the work in progress while the read had not begun.
  app.send({
    type: 'message_end',
    entry: { id: 30, model: [{ role: 'assistant', content: [
      { type: 'toolCall', id: 'p1', name: 'read', arguments: { path: 'x' } },
      { type: 'toolCall', id: 'p2', name: 'bash', arguments: { command: 'ls' } },
    ] }] },
  });
  await app.settle();

  const metas = () => [...app.document.querySelectorAll('.msg.assistant details.tool .meta')].map((m) => m.textContent.trim());
  const strip = () => app.document.querySelector('.strip').textContent.replace(/\s+/g, ' ').trim();
  assert.deepEqual(metas(), ['queued', 'queued'], 'a call that has not started claims to be running');
  assert.doesNotMatch(strip(), /read/, 'the strip named a tool that had not started');

  app.send({ type: 'tool_execution_start', toolCallId: 'p1', toolName: 'read', args: { path: 'x' } });
  await app.settle();
  assert.deepEqual(metas(), ['running…', 'queued'], 'starting one call changed the other');
  assert.match(strip(), /working · read/, 'the strip does not show the tool that is running');

  app.send({
    type: 'tool_execution_end', toolCallId: 'p1', toolName: 'read',
    entry: { id: 31, model: [{ role: 'toolResult', toolCallId: 'p1', content: [{ type: 'text', text: 'ok' }] }] },
  });
  await app.settle();
  assert.deepEqual(metas(), ['2 chars', 'queued'], 'the finished call or the waiting one is wrong');
});

test('a snapshot keeps a call that has not started queued', async () => {
  const app = await mount();
  const frame = (tools) => ({
    type: 'bridge_snapshot',
    sessionName: 'Main',
    snapshot: {
      entries: [{ id: 40, kind: 'pi.assistant', model: [{ role: 'assistant', content: [
        { type: 'toolCall', id: 'p1', name: 'read', arguments: { path: 'x' } },
        { type: 'toolCall', id: 'p2', name: 'bash', arguments: { command: 'ls' } },
      ] }] }],
      tools,
      run: { inputs: [] },
    },
  });

  // A reload, a reconnect and a session switch all arrive as this frame, and
  // its `tools` is the whole current round in call order -- not the running
  // set. The per-slot status is the only thing that says which call has begun.
  app.send(frame([
    { callId: 'p1', name: 'read', status: 'pending' },
    { callId: 'p2', name: 'bash', status: 'pending' },
  ]));
  await app.settle();

  const metas = () => [...app.document.querySelectorAll('.msg.assistant details.tool .meta')].map((m) => m.textContent.trim());
  const strip = () => app.document.querySelector('.strip').textContent.replace(/\s+/g, ' ').trim();
  assert.deepEqual(metas(), ['queued', 'queued'], 'a snapshot promoted an unstarted call to running');
  assert.doesNotMatch(strip(), /read|bash/, 'the strip named a tool that had not started');

  app.send(frame([
    { callId: 'p1', name: 'read', status: 'running' },
    { callId: 'p2', name: 'bash', status: 'pending' },
  ]));
  await app.settle();
  assert.deepEqual(metas(), ['running…', 'queued'], 'the snapshot did not use each slot\'s own status');
  assert.match(strip(), /working · read/, 'the strip does not name the tool that is running');
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

test('the menu says when an extension is waiting for the user', async () => {
  const app = await mount({
    extensions: { installed: [], proposals: [{ key: 'demo.mjs', hash: 'a'.repeat(64), state: 'pending', bytes: 10, diff: '' }] },
  });
  await app.settle();
  const menu = [...app.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Menu');
  menu.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  assert.match(app.text(), /1 to review/, 'the menu does not say that a proposal is waiting');
});

test('the extensions sheet shows the file, the hash and the diff', async () => {
  const app = await mount({
    extensions: {
      installed: [],
      proposals: [{
        key: 'demo.mjs', hash: 'a'.repeat(64), state: 'pending', bytes: 42,
        diff: '@@ -1,0 +1,2 @@\n+export default {\n+  name: "demo"',
        content: 'export default {\n  name: "demo"\n',
      }],
    },
  });
  await app.settle();
  const menu = [...app.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Menu');
  menu.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const item = [...app.document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Extensions'));
  item.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const text = app.text();
  assert.match(text, /demo\.mjs/, 'the proposal is not named');
  assert.match(text, /aaaaaaaaaaaa/, 'the hash is not shown');
  assert.match(text, /\+export default/, 'the diff is not shown');
});

test('the whole file is there to read, not only the diff', async () => {
  const app = await mount({
    extensions: {
      installed: [],
      proposals: [{
        key: 'demo.mjs', hash: 'a'.repeat(64), state: 'pending', bytes: 42,
        diff: '@@ -1,0 +1,2 @@\n+export default {',
        content: 'export default { name: "demo" }',
      }],
    },
  });
  await app.settle();
  const menu = [...app.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Menu');
  menu.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const item = [...app.document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Extensions'));
  item.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  // Nothing is ever approved unseen: the whole file is in the sheet.
  assert.match(app.text(), /export default \{ name: "demo" \}/);
  assert.ok(app.document.querySelector('details.whole'), 'there is no way to see the whole file');
});

test('a proposal that does not install says so', async () => {
  const app = await mount({
    extensions: {
      installed: [],
      proposals: [{
        key: 'broken.mjs', hash: 'a'.repeat(64), state: 'failed', bytes: 10,
        diff: '', content: 'export default {}', error: 'the extension needs a name',
      }],
      problems: [{ key: 'gone.mjs', error: 'the file is gone' }],
    },
  });
  await app.settle();
  const menu = [...app.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Menu');
  menu.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const item = [...app.document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Extensions'));
  item.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const text = app.text();
  assert.match(text, /the extension needs a name/, 'the failure is not on the card');
  assert.match(text, /the file is gone/, 'a problem is not shown');
});

test('an installed extension is listed once', async () => {
  const app = await mount({
    extensions: {
      installed: [{ key: 'demo.mjs', name: 'demo', hash: 'a'.repeat(64), installedAt: 1 }],
      proposals: [{
        key: 'demo.mjs', hash: 'a'.repeat(64), state: 'installed', bytes: 42, diff: '', content: '',
      }],
    },
  });
  await app.settle();
  const menu = [...app.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Menu');
  menu.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const item = [...app.document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Extensions'));
  item.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const rows = [...app.document.querySelectorAll('.row')].filter((r) => (r.textContent ?? '').includes('demo.mjs'));
  assert.equal(rows.length, 1, `the extension is listed ${rows.length} times`);
});

test('installing sends the hash the user was shown', async () => {
  const hash = 'b'.repeat(64);
  const app = await mount({
    extensions: { installed: [], proposals: [{ key: 'demo.mjs', hash, state: 'pending', bytes: 42, diff: '' }] },
  });
  await app.settle();
  const menu = [...app.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Menu');
  menu.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const item = [...app.document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Extensions'));
  item.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const install = [...app.document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Install');
  assert.ok(install, 'there is no Install button');
  install.dispatchEvent(new window.Event('click', { bubbles: true }));
  await app.settle();
  const call = app.fetches.find(([url]) => url.includes('/api/extensions/install'));
  assert.ok(call, 'the install was not posted');
  const body = JSON.parse(call[1].body);
  assert.equal(body.key, 'demo.mjs');
  // The hash the user saw is the hash that is sent: the server refuses a file
  // that changed since.
  assert.equal(body.hash, hash);
});

test('a proposal that arrives is fetched, not waited for', async () => {
  const app = await mount();
  app.send({ type: 'bridge_snapshot', sessionName: 'Main', snapshot: { entries: [], run: null } });
  await app.settle();
  const before = app.fetches.filter(([url]) => url.includes('/api/extensions')).length;
  app.send({ type: 'bridge_extensions' });
  await app.settle();
  const after = app.fetches.filter(([url]) => url.includes('/api/extensions')).length;
  assert.ok(after > before, 'the client did not ask for the proposals again');
});

test('a client paints into the document it booted into, and into no other', async () => {
  // A browser gives a module one document for its whole life, so this cannot
  // happen in production. The harness is where two documents exist at once:
  // it re-imports the module per test and swaps the process-wide `document`,
  // which modeled "the page is gone" as "document is now someone else's".
  // While the client read the global at paint time, an instance that outlived
  // its test -- one with a pending OAuth poll -- painted into the next test's
  // DOM and took its Extensions sheet, Install button and all.
  const app = await mount();
  const mine = app.document;
  app.send({ type: 'bridge_snapshot', sessionName: 'Mine', snapshot: { entries: [], run: null } });
  await app.settle();
  assert.match(mine.getElementById('app').textContent, /Mine/, 'the first snapshot did not render');

  // Another document becomes the global one.
  const other = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>').document;
  globalThis.document = other;
  try {
    app.send({ type: 'bridge_snapshot', sessionName: 'Other', snapshot: { entries: [], run: null } });
    await app.settle();
    assert.match(mine.getElementById('app').textContent, /Other/, 'the client did not paint into its own document');
    assert.equal(other.getElementById('app').textContent, '', 'the client painted into a document it did not boot into');
  } finally {
    // Restore even when an assertion above throws, so the rest of the file
    // does not run against a document belonging to a finished test.
    globalThis.document = mine;
  }
});

// ── the frame watermark ──────────────────────────────────────────────────
// The bridge stamps every frame it writes with `seq` and answers a reconnect with
// `gapped`. What the client has to get right is the number it asks from: the frame
// it actually last saw, not the one this page loaded with.

test('a client that has seen nothing asks for no watermark', async () => {
  const app = await mount();
  assert.equal(app.sources.length, 1, 'the client should open one stream at boot');
  assert.doesNotMatch(app.sources[0].url, /since=/, 'a fresh client claimed a watermark it does not have');
});

test('a reconnect asks from the frame it last saw', async () => {
  const app = await mount();
  app.send({ type: 'bridge_snapshot', seq: 7, snapshot: { entries: [], run: null } });
  await app.settle();
  await app.reconnect();
  assert.match(app.sources[1].url, /since=7/, 'the reconnect did not ask from the watermark the client has');
});

test('a reload asks from the stored watermark', async () => {
  const app = await mount({ stored: { 'pi-lastSeq': '9' } });
  assert.match(app.sources[0].url, /since=9/, 'a reload did not use the stored watermark');
});

test('a watermark from another bridge run is dropped', async () => {
  // The counter starts at zero with the bridge process; the stored number does not.
  const app = await mount({ stored: { 'pi-lastSeq': '42', 'pi-epoch': 'previous-run' } });
  app.send({ type: 'bridge_connected', epoch: 'this-run', seq: 1 });
  await app.settle();
  await app.reconnect();
  assert.match(app.sources[1].url, /since=1/, 'a number from the previous run was compared against this one');
  assert.equal(app.stored.get('pi-epoch'), 'this-run');
});

test('a gapped reconnect says so, and a plain attach says nothing', async () => {
  const app = await mount();
  app.send({ type: 'bridge_snapshot', seq: 3, gapped: false, snapshot: { entries: [], run: null } });
  await app.settle();
  assert.doesNotMatch(app.text(), /reconnected/, 'a first attach announced a reconnect');

  app.send({ type: 'bridge_snapshot', seq: 9, gapped: true, snapshot: { entries: [], run: null } });
  await app.settle();
  assert.match(app.text(), /reconnected/, 'a gapped reconnect was not shown');
});

test('the watermark is stored once per burst, not once per frame', async () => {
  const app = await mount();
  app.sendMany([{ type: 'run_start', seq: 1 }, { type: 'run_end', seq: 2 }]);
  await app.settle();
  assert.equal(app.stored.has('pi-lastSeq'), false, 'every streamed frame wrote to storage');
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(app.stored.get('pi-lastSeq'), '2', 'the watermark never reached storage');
});

// models.json: the user's own models, layered over the bundled catalog.
//
// The CLI reads this file natively; the bridge has to do it itself. These tests
// pin the behaviour that matters: a configured model shows up next to the
// provider's own models, the provider's own models survive, and a broken file
// or a broken entry never costs the phone its models.
//
//   node test/models-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applyModelsConfig, configuredModels, loadModelsConfig } from '../runtime/models-config.mjs';

/** A provider that looks like the real ones: a fixed catalog, one api. */
function fakeProvider(models, { id = 'opencode-go', api = 'anthropic-messages' } = {}) {
  return {
    id,
    api,
    getModels: () => models,
    getAllModels: () => models,
  };
}

const BUILTIN = [
  { id: 'minimax-m3', api: 'anthropic-messages', baseUrl: 'https://example.test/go' },
  { id: 'kimi-k3', api: 'openai-completions', baseUrl: 'https://example.test/go/v1' },
];

test('a configured model is added to the provider catalog', () => {
  const provider = fakeProvider(BUILTIN);
  const models = { getProvider: (id) => (id === 'opencode-go' ? provider : undefined) };
  const applied = applyModelsConfig(models, {
    providers: {
      'opencode-go': {
        models: [
          { id: 'minimax-m3.1-flash-free', name: 'MiniMax M3.1 Flash Free', api: 'anthropic-messages', baseUrl: 'https://example.test/go', contextWindow: 1000000, maxTokens: 512000 },
        ],
      },
    },
  });
  assert.deepEqual(applied, ['opencode-go/minimax-m3.1-flash-free']);
  const ids = provider.getModels().map((m) => m.id);
  assert.ok(ids.includes('minimax-m3.1-flash-free'));
});

test('the provider own models are kept, and a known id is replaced in place', () => {
  const provider = fakeProvider(BUILTIN);
  const models = { getProvider: () => provider };
  applyModelsConfig(models, {
    providers: {
      'opencode-go': {
        models: [{ id: 'minimax-m3', name: 'MiniMax M3 (custom)', api: 'anthropic-messages', baseUrl: 'https://example.test/go' }],
      },
    },
  });
  const ids = provider.getModels().map((m) => m.id);
  assert.equal(ids.length, 2, 'a replaced model does not add a second one');
  assert.ok(ids.includes('kimi-k3'), 'the other model survives');
  assert.equal(provider.getModels().find((m) => m.id === 'minimax-m3').name, 'MiniMax M3 (custom)');
});

test('the defaults are the ones the CLI fills in', () => {
  const provider = fakeProvider(BUILTIN);
  const [model] = configuredModels(provider, { models: [{ id: 'new-model', api: 'anthropic-messages', baseUrl: 'https://example.test/go' }] });
  assert.equal(model.contextWindow, 128000);
  assert.equal(model.maxTokens, 16384);
  assert.deepEqual(model.input, ['text']);
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('a definition without an id is skipped, not fatal', () => {
  const provider = fakeProvider(BUILTIN);
  const models = { getProvider: () => provider };
  const applied = applyModelsConfig(models, {
    providers: {
      'opencode-go': {
        models: [
          { api: 'anthropic-messages', baseUrl: 'https://example.test/go' }, // no id
        ],
      },
    },
  });
  assert.deepEqual(applied, []);
  assert.equal(provider.getModels().length, 2);
});

test('a definition without an api or a baseUrl inherits them, as the CLI does', () => {
  // The CLI fills a missing api or baseUrl from the provider's own models, so
  // "{ id }" alone is a model of the provider's default api at its default url.
  const provider = fakeProvider(BUILTIN);
  const models = { getProvider: () => provider };
  applyModelsConfig(models, {
    providers: { 'opencode-go': { models: [{ id: 'bare' }] } },
  });
  const model = provider.getModels().find((m) => m.id === 'bare');
  assert.equal(model.api, 'anthropic-messages');
  assert.equal(model.baseUrl, 'https://example.test/go');
});

test('a definition with neither api nor baseUrl is skipped when there is nothing to inherit', () => {
  const provider = fakeProvider([]);
  const models = { getProvider: () => provider };
  const applied = applyModelsConfig(models, {
    providers: { 'opencode-go': { models: [{ id: 'bare' }] } },
  });
  assert.deepEqual(applied, []);
  assert.equal(provider.getModels().length, 0);
});

test('a provider the runtime does not know is skipped', () => {
  const provider = fakeProvider(BUILTIN);
  const models = { getProvider: (id) => (id === 'opencode-go' ? provider : undefined) };
  const applied = applyModelsConfig(models, {
    providers: { 'not-a-provider': { models: [{ id: 'x', api: 'anthropic-messages', baseUrl: 'https://example.test' }] } },
  });
  assert.deepEqual(applied, []);
});

test('a file that does not parse is no models, not a crash', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'models-config-'));
  const file = path.join(dir, 'models.json');
  writeFileSync(file, '{ this is not json');
  assert.equal(loadModelsConfig(file), null);
});

test('the file is read from the agent directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'models-config-'));
  const file = path.join(dir, 'models.json');
  writeFileSync(file, JSON.stringify({ providers: {} }));
  assert.deepEqual(loadModelsConfig(file), { providers: {} });
});

// --- the contract the fake provider cannot show ---------------------------------------
//
// Every test above uses a fake provider. That fake cannot tell us whether the
// real pi-ai catalog is shaped the way this module assumes, and a change in
// pi-ai would leave these tests green while the feature silently did nothing.
// The next four tests use the real catalog, and the real functions.

// The live catalog lives in runtime/node_modules, and its package exports only
// an "import" condition, so a bare specifier cannot be required from here and
// a bare specifier from test/ would not resolve it at all. Read the package's
// own exports map and import the files it names.
const piAiPackage = new URL('../runtime/node_modules/@earendil-works/pi-ai/package.json', import.meta.url);
const piAiExports = JSON.parse(readFileSync(piAiPackage, 'utf8')).exports;
const piAiFile = (subpath) => {
  const exact = piAiExports[subpath];
  if (exact) return new URL(exact.import, piAiPackage).href;
  // "./providers/*" and friends: match the wildcard.
  for (const [key, value] of Object.entries(piAiExports)) {
    if (!key.includes('*')) continue;
    const [head, tail] = key.split('*');
    if (!subpath.startsWith(head) || !subpath.endsWith(tail)) continue;
    const middle = subpath.slice(head.length, subpath.length - tail.length);
    return new URL(value.import.replace('*', middle), piAiPackage).href;
  }
  throw new Error(`no export for ${subpath}`);
};
const { createModels } = await import(piAiFile('./models'));
const { builtinProviders } = await import(piAiFile('./providers/all'));
const { agentConfigDir } = await import('../runtime/models-config.mjs');

test('the real pi-ai catalog accepts a configured model', () => {
  const models = createModels({ credentials: {} });
  for (const provider of builtinProviders()) models.setProvider(provider);

  // The three facts this module relies on, against the real catalog.
  const provider = models.getProvider('openai');
  assert.ok(provider, 'the real catalog has no openai provider');
  assert.equal(typeof provider.getModels, 'function');
  assert.equal(typeof provider.getAllModels, 'function');
  assert.ok(Array.isArray(provider.getModels()) && provider.getModels().length > 0);

  const before = provider.getModels().length;
  const applied = applyModelsConfig(models, {
    providers: {
      openai: {
        models: [{ id: 'my-model', name: 'My Model', api: 'openai-completions', baseUrl: 'https://example.test/v1' }],
      },
    },
  });
  assert.deepEqual(applied, ['openai/my-model']);

  const after = provider.getModels();
  assert.equal(after.length, before + 1, 'the configured model is not in the real catalog');
  assert.ok(after.some((m) => m.id === 'my-model'));
  assert.ok(after.some((m) => m.id !== 'my-model'), 'the provider lost its own models');
});

test('getAllModels is patched as well as getModels', () => {
  const models = createModels({ credentials: {} });
  for (const provider of builtinProviders()) models.setProvider(provider);
  const provider = models.getProvider('openai');
  const before = provider.getAllModels().length;
  applyModelsConfig(models, {
    providers: { openai: { models: [{ id: 'my-model', api: 'openai-completions', baseUrl: 'https://example.test/v1' }] } },
  });
  assert.equal(provider.getAllModels().length, before + 1);
  assert.ok(provider.getAllModels().some((m) => m.id === 'my-model'));
});

test('the catalog is not frozen: a later refresh is visible', () => {
  // models.refresh() is reached from /api/auth and after an OAuth login, so a
  // provider whose catalog changes must show the change, not the boot snapshot.
  let catalog = [{ id: 'old-1', api: 'anthropic-messages', baseUrl: 'https://example.test' }];
  const provider = {
    id: 'opencode-go',
    api: 'anthropic-messages',
    getModels: () => catalog,
    getAllModels: () => catalog,
  };
  const models = { getProvider: (id) => (id === 'opencode-go' ? provider : undefined) };
  applyModelsConfig(models, {
    providers: { 'opencode-go': { models: [{ id: 'mine', api: 'anthropic-messages', baseUrl: 'https://example.test' }] } },
  });
  assert.ok(provider.getModels().some((m) => m.id === 'old-1'));

  catalog = [{ id: 'new-1', api: 'anthropic-messages', baseUrl: 'https://example.test' }];
  const ids = provider.getModels().map((m) => m.id);
  assert.ok(ids.includes('new-1'), 'the refreshed catalog is invisible');
  assert.ok(ids.includes('mine'), 'the configured model was lost');
});

test('a provider that will not list its models costs the phone nothing', () => {
  const provider = {
    id: 'broken',
    api: 'anthropic-messages',
    getModels: () => { throw new Error('provider catalog unavailable'); },
    getAllModels: () => { throw new Error('provider catalog unavailable'); },
  };
  const models = { getProvider: (id) => (id === 'broken' ? provider : undefined) };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let applied;
  try {
    applied = applyModelsConfig(models, {
      providers: { broken: { models: [{ id: 'x', api: 'anthropic-messages', baseUrl: 'https://example.test' }] } },
    });
  } finally {
    console.error = original;
  }
  // It does not throw, and the provider still yields the model the user wrote
  // down, because that definition carries its own api and baseUrl.
  assert.deepEqual(applied, ['broken/x']);
  assert.doesNotThrow(() => provider.getModels(), 'the patched accessor still throws');
  assert.deepEqual(provider.getModels().map((m) => m.id), ['x']);
  assert.ok(errors.length >= 1, 'the failure was not reported');
});

test('a provider this runtime does not know is reported, not skipped in silence', () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const models = { getProvider: () => undefined };
    applyModelsConfig(models, {
      providers: { 'not-a-provider': { models: [{ id: 'x', api: 'anthropic-messages', baseUrl: 'https://example.test' }] } },
    });
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1, 'an unknown provider was skipped without saying so');
  assert.match(errors[0], /not-a-provider/);
});

test('the agent directory is where models.json is read from', () => {
  assert.equal(agentConfigDir({ PI_AGENT_DIR: '/custom/agent', HOME: '/home/x' }), '/custom/agent');
  assert.equal(agentConfigDir({ PI_AGENT_DIR: '~', HOME: '/home/x' }), '/home/x');
  assert.equal(agentConfigDir({ PI_AGENT_DIR: '~/sub', HOME: '/home/x' }), '/home/x/sub');
  assert.equal(agentConfigDir({ HOME: '/home/x' }), '/home/x/.pi/agent');
});

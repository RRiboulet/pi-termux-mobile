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
import { mkdtempSync, writeFileSync } from 'node:fs';
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

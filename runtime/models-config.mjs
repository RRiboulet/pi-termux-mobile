// models-config.mjs — user-defined models from ~/.pi/agent/models.json.
//
// The pi CLI reads this file natively: `models.json` sits next to auth.json in
// the agent directory, and the CLI layers the entries over its bundled catalog
// (a `models` entry adds or replaces one model by id, the rest of the
// provider's catalog is kept). The phone bridge builds its own catalog, so it
// needs its own reader for the same file.
//
// The file looks like this:
//
//   {
//     "providers": {
//       "opencode-go": {
//         "models": [
//           {
//             "id": "minimax-m3.1-flash-free",
//             "name": "MiniMax M3.1 Flash Free",
//             "api": "anthropic-messages",
//             "baseUrl": "https://opencode.ai/zen/go",
//             "reasoning": true,
//             "thinkingLevelMap": { "off": null, "minimal": "low", "max": "max" },
//             "input": ["text", "image"],
//             "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
//             "contextWindow": 1000000,
//             "maxTokens": 512000,
//             "compat": { "forceAdaptiveThinking": true }
//           }
//         ]
//       }
//     }
//   }
//
// Only what the bridge can honour is applied: chat models with an id, an api
// and a baseUrl. A provider that the runtime does not know is skipped, and a
// malformed entry is ignored rather than taken as a reason to fail the boot —
// a broken models.json must not leave the phone with no models at all.

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Where the agent keeps auth.json and models.json. */
export function agentConfigDir(env = process.env) {
  const configured = env.PI_AGENT_DIR;
  const home = env.HOME || process.cwd();
  if (configured) {
    if (configured === '~') return home;
    if (configured.startsWith('~/')) return path.join(home, configured.slice(2));
    return configured;
  }
  return path.join(home, '.pi', 'agent');
}

/** The parsed models.json, or null when there is none or it does not parse. */
export function loadModelsConfig(file = path.join(agentConfigDir(), 'models.json')) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One model definition, with the defaults the CLI would fill in.
 * Returns null when the definition cannot produce a usable model.
 */
export function modelFromDefinition(providerId, providerConfig, definition, defaults) {
  if (!definition || typeof definition !== 'object') return null;
  if (!definition.id || typeof definition.id !== 'string') return null;
  const api = definition.api ?? providerConfig.api ?? defaults?.api;
  const baseUrl = definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
  if (!api || !baseUrl) return null;
  return {
    id: definition.id,
    name: definition.name ?? definition.id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: definition.reasoning ?? false,
    thinkingLevelMap: definition.thinkingLevelMap,
    input: definition.input ?? ['text'],
    inputLimits: definition.inputLimits,
    cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    promptCache: definition.promptCache,
    contextWindow: definition.contextWindow ?? 128000,
    maxTokens: definition.maxTokens ?? 16384,
    samplingParams: definition.samplingParams,
    samplingParamsByThinkingLevel: definition.samplingParamsByThinkingLevel,
    headers: undefined,
    compat: { ...(providerConfig.compat ?? {}), ...(definition.compat ?? {}) },
  };
}

/**
 * Layer the configured models over a provider's own catalog.
 * A model with a known id replaces that entry; a new id is appended. The
 * provider's other models stay exactly as they were.
 */
export function configuredModels(provider, providerConfig) {
  if (!Array.isArray(providerConfig?.models) || !providerConfig.models.length) return [];
  const baseModels = provider.getModels();
  return providerConfig.models
    .map((definition) => {
      const existing = baseModels.find((model) => model.id === definition?.id);
      const sameApi = baseModels.find((model) => model.api === (definition?.api ?? providerConfig.api));
      return modelFromDefinition(provider.id, providerConfig, definition, existing ?? sameApi ?? baseModels[0]);
    })
    .filter(Boolean);
}

/**
 * Apply models.json to a live model collection.
 * Returns the ids that were added or replaced, for logging.
 */
export function applyModelsConfig(models, config) {
  const applied = [];
  if (!config?.providers || typeof config.providers !== 'object') return applied;
  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    const provider = models.getProvider(providerId);
    if (!provider) continue; // a provider this runtime does not know
    const configured = configuredModels(provider, providerConfig);
    if (!configured.length) continue;
    const baseModels = provider.getModels();
    const baseAll = provider.getAllModels?.() ?? baseModels;
    const merge = (entries) => {
      const result = [...entries];
      for (const model of configured) {
        const index = result.findIndex((entry) => entry.id === model.id && (entry.type ?? 'chat') === 'chat');
        if (index >= 0) result[index] = model; else result.push(model);
      }
      return result;
    };
    provider.getModels = () => merge(baseModels);
    if (provider.getAllModels) provider.getAllModels = () => merge(baseAll);
    applied.push(...configured.map((model) => `${providerId}/${model.id}`));
  }
  return applied;
}

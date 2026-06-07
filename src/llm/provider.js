import { createOllamaProvider } from './ollama.js';

// Factory selecting an LLM provider by name. Add 'gemini'/'openai' here later;
// the interface (generate({ system, prompt }) → string) stays stable.
export function createProvider(name, cfg, fetchImpl = fetch) {
  switch (name) {
    case 'local':
      return createOllamaProvider(cfg.ollama, fetchImpl);
    default:
      throw new Error(`Unknown LLM provider: ${name}`);
  }
}

export const DEFAULT_MODELS = {
  local: 'qwen2.5:7b',
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
};

// Maps a stored { provider, model } config to a concrete provider instance.
// `factory({ type, model })` is injectable for tests; the default routes through
// createProvider, overlaying the chosen model onto the provider's config block.
// Live callers should pass a cfg-aware factory so the provider gets full config
// (e.g. the Ollama URL). Unknown provider names fall back to 'local'.
export function resolveProvider({ provider, model } = {}, factory = defaultFactory) {
  const type = DEFAULT_MODELS[provider] ? provider : 'local';
  return factory({ type, model: model ?? DEFAULT_MODELS[type] });
}

function defaultFactory({ type, model }) {
  return createProvider(type, { ollama: { model } });
}

import { createOllamaProvider } from './ollama.js';
import { createOpenAICompatProvider } from './openai.js';
import { createTieredProvider } from './tiered.js';

// Which config block feeds each provider type.
const CFG_BLOCK = { local: 'ollama', openai: 'openai', gemini: 'gemini' };

// Factory selecting an LLM provider by name. The interface
// (generate({ system, prompt }) → string) stays stable across families.
export function createProvider(name, cfg, fetchImpl = fetch) {
  switch (name) {
    case 'local':
      return buildLocalProvider(cfg, fetchImpl);
    case 'openai':
      return createOpenAICompatProvider({ name: 'openai', ...cfg.openai }, fetchImpl);
    case 'gemini':
      return createOpenAICompatProvider({ name: 'gemini', ...cfg.gemini }, fetchImpl);
    default:
      throw new Error(`Unknown LLM provider: ${name}`);
  }
}

export const DEFAULT_MODELS = {
  local: 'qwen2.5:7b',
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
};

// Overlays an agent's sampling options (temperature, seed) onto every provider
// config block. Distinct per-agent sampling decorrelates agents that share one
// base model — the cheapest form of panel diversity — and the persona survives
// a dashboard switch to another provider family.
export function withAgentOptions(cfg, options) {
  if (!options) return cfg;
  const out = { ...cfg };
  for (const block of Object.values(CFG_BLOCK)) {
    out[block] = { ...out[block], options };
  }
  return out;
}

// Overlays a chosen model onto the config block the given provider type reads.
export function withModel(cfg, type, model) {
  const block = CFG_BLOCK[type];
  return { ...cfg, [block]: { ...cfg[block], model: model ?? cfg[block]?.model } };
}

// Maps a stored { provider, model } config to a concrete provider instance.
// `factory({ type, model })` is injectable for tests; the default routes through
// createProvider, overlaying the chosen model onto the provider's config block.
// Live callers should pass a cfg-aware factory so the provider gets full config
// (e.g. the Ollama URL or an API key). Unknown provider names fall back to 'local'.
export function resolveProvider({ provider, model } = {}, factory = defaultFactory) {
  const type = DEFAULT_MODELS[provider] ? provider : 'local';
  return factory({ type, model: model ?? DEFAULT_MODELS[type] });
}

function defaultFactory({ type, model }) {
  return createProvider(type, withModel({}, type, model));
}

// The `local` provider is tiered when a home PC URL is configured AND not disabled:
// primary = PC Ollama (cfg.home), fallback = Oracle Ollama (cfg.ollama). Otherwise it
// is the plain Oracle Ollama provider — byte-identical to before this feature.
function buildLocalProvider(cfg, fetchImpl) {
  const oracle = createOllamaProvider(cfg.ollama, fetchImpl);
  const home = cfg.home;
  if (!home?.url || home.enabled === false) return oracle;

  const pc = createOllamaProvider(
    { ...cfg.ollama, url: home.url, model: home.model, think: home.think },
    fetchImpl,
  );
  const probe = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), home.probeTimeoutMs);
    try {
      const res = await fetchImpl(`${home.url}/api/tags`, { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  return createTieredProvider({ primary: pc, fallback: oracle, probe });
}

// Normalizes the provider generate contract: plain providers return a string,
// the tiered provider returns { text, model }. Callers that need the served model
// (the agent runner) use this; text-only callers read `.text`.
export async function normalizeGenerate(provider, args) {
  const out = await provider.generate(args);
  if (typeof out === 'string') return { text: out, model: provider.model ?? null };
  return out;
}

// Composite key for per-(agent, model) reliability dial maps. NUL never appears in
// an agent id or an Ollama model name, so it is a safe, reversible separator.
export function modelKey(agentId, model) {
  return `${agentId} ${model}`;
}

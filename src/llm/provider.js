import { createOllamaProvider } from './ollama.js';
import { createOpenAICompatProvider } from './openai.js';
import { createTieredProvider } from './tiered.js';

// Which config block feeds each provider type.
const CFG_BLOCK = { local: 'ollama', openai: 'openai', gemini: 'gemini' };

// Factory selecting an LLM provider by name. The interface
// (generate({ system, prompt }) → string) stays stable across families.
// fetchImpl is used by openai/gemini providers and the tiered-local probe.
// clientFactory (injectable for tests) overrides the Ollama client constructor.
export function createProvider(name, cfg, fetchImpl = fetch, clientFactory = undefined) {
  switch (name) {
    case 'local':
      return buildLocalProvider(cfg, fetchImpl, clientFactory);
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

// Overlays a chosen model onto the config block the given provider type reads. A null
// model means "no override" — keep whatever the cfg block already has (the env default
// or a runtime override), rather than clobbering it.
//
// For 'local' the placement depends on whether a home PC is CONFIGURED (home.url set):
//   - PC configured: the chosen model is the PC PRIMARY's (cfg.home.model) — it was
//     picked from the PC's pulled-model list. The Oracle keeps its own model
//     (cfg.ollama.model, the env default / `oracle_model` runtime knob) — the CPU-only
//     Oracle box can't run a PC-sized model (e.g. gpt-oss:20b) inside its timeout, so
//     leaking the PC model onto it makes every Oracle call hit the timeout and abstain.
//     This holds even while the PC toggle is OFF (home.enabled === false): running
//     VM-only must not hand the Oracle the PC's model — the override simply sits idle
//     on the home block until the PC tier is re-enabled.
//   - No PC configured ('local' IS the sole Ollama): the model applies to cfg.ollama.model.
export function withModel(cfg, type, model) {
  if (type === 'local' && model) {
    return cfg.home?.url
      ? { ...cfg, home: { ...cfg.home, model } }
      : { ...cfg, ollama: { ...cfg.ollama, model } };
  }
  const block = CFG_BLOCK[type];
  return { ...cfg, [block]: { ...cfg[block], model: model ?? cfg[block]?.model } };
}

// Maps a stored { provider, model } config to a concrete provider instance.
// `factory({ type, model })` is injectable for tests; the default routes through
// createProvider, overlaying the chosen model onto the provider's config block.
// Live callers should pass a cfg-aware factory so the provider gets full config
// (e.g. the Ollama URL or an API key). Unknown provider names fall back to 'local'.
//
// A null model is passed through unchanged: a cfg-aware factory keeps the configured
// model (so global/runtime model settings stand), and only the cfg-less defaultFactory
// substitutes the family default for a bare provider switch.
export function resolveProvider({ provider, model } = {}, factory = defaultFactory) {
  const type = DEFAULT_MODELS[provider] ? provider : 'local';
  return factory({ type, model: model ?? null });
}

function defaultFactory({ type, model }) {
  return createProvider(type, withModel({}, type, model ?? DEFAULT_MODELS[type]));
}

// The `local` provider is PC-preferred when a home PC URL is configured AND not
// disabled: primary = PC Ollama (cfg.home, committed to when the probe passes),
// fallback = Oracle Ollama (cfg.ollama, only when the PC is unavailable). Otherwise it
// is the plain Oracle Ollama provider — byte-identical to before this feature.
function buildLocalProvider(cfg, fetchImpl, clientFactory) {
  const oracle = createOllamaProvider({ ...cfg.ollama, source: 'oracle' }, clientFactory);
  const home = cfg.home;
  if (!home?.url || home.enabled === false) return oracle;

  const pc = createOllamaProvider(
    {
      ...cfg.ollama,
      url: home.url,
      model: home.model,
      think: home.think,
      // PC-preferred: commit and queue, so the PC call needs a longer deadline than
      // the Oracle box to outlast a deep NUM_PARALLEL queue instead of aborting.
      timeoutMs: home.timeoutMs ?? cfg.ollama.timeoutMs,
      source: 'pc',
    },
    clientFactory,
  );
  // Liveness probe hits the sidecar's dedicated /ready endpoint, NOT /api/tags. /ready
  // has its own isolated worker pool on the PC, so it answers in ~ms even while every
  // generate slot is busy with other votes — the probe no longer times out under a
  // sweep and wrongly load-sheds to Oracle. We commit to the PC (queue, don't fail over)
  // only when /ready reports ready:true.
  //
  // One probe attempt distinguishes three outcomes:
  //   { state: 'ready' }     — /ready answered ready:true  → commit to the PC.
  //   { state: 'busy' }      — /ready answered ready:false → operator is gaming; this is
  //                            a DEFINITIVE answer, so go to Oracle immediately, no retry.
  //   { state: 'unreachable' } — non-200 / network / timeout: we couldn't tell. The PC is
  //                            the preferred tier, so a single cold Tailscale hop must not
  //                            dump the whole sweep onto the slow Oracle — retry a few
  //                            times before treating the PC as offline.
  const probeOnce = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), home.probeTimeoutMs);
    try {
      const res = await fetchImpl(`${home.url}/ready`, { signal: controller.signal });
      if (!res.ok) return { state: 'unreachable' };
      const body = await res.json();
      return { state: body?.ready === true ? 'ready' : 'busy' };
    } catch {
      return { state: 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  };
  const probe = async () => {
    const attempts = Math.max(1, home.probeRetries ?? 3);
    const gapMs = home.probeRetryGapMs ?? 300;
    for (let i = 0; i < attempts; i++) {
      const { state } = await probeOnce();
      if (state === 'ready') return true;
      if (state === 'busy') return false; // definitive gaming-gate; don't wait it out
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
    return false; // every attempt was unreachable → PC offline → Oracle
  };
  return createTieredProvider({ primary: pc, fallback: oracle, probe, allowFallback: home.fallback });
}

// Normalizes the provider generate contract: plain providers return a string,
// the tiered provider returns { text, model, source }. Callers that need the served
// model and source (the agent runner) use this; text-only callers read `.text`.
export async function normalizeGenerate(provider, args) {
  const out = await provider.generate(args);
  if (typeof out === 'string') {
    return { text: out, model: provider.model ?? null, source: provider.source ?? null };
  }
  return out;
}

// Composite key for per-(agent, model) reliability dial maps. NUL never appears in
// an agent id or an Ollama model name, so it is a safe, reversible separator.
export function modelKey(agentId, model) {
  return `${agentId} ${model}`;
}

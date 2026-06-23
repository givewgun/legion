import { resolveProvider, createProvider, withAgentOptions, withModel } from '../llm/provider.js';
import { applyRuntimeOverrides } from '../config/runtime-overrides.js';

// Builds the per-cycle getProvider({ agentId }) callback the agent factory uses to
// honor runtime config in legion.agent_config. Resolution per cycle means a change
// saved on the dashboard Agents tab takes effect on the next evaluation, no redeploy.
//
// Returns:
//   null               — no persisted row; factory keeps its static injected provider
//   { enabled: false } — muted agent; factory abstains (HOLD/0) without an LLM call,
//                        and no provider is constructed (so a not-yet-implemented
//                        provider name on a disabled agent never throws)
//   { provider, enabled: true } — provider resolved from the row's provider/model
//
// `factory` is injectable for tests; the default routes through createProvider,
// overlaying the chosen model onto the provider's config block while preserving the
// rest of cfg (e.g. the Ollama URL and resilience options). `options` carries the
// agent's static sampling settings (temperature, seed) so a dashboard model switch
// keeps the agent's sampling persona.
export function buildGetProvider({ repo, cfg = {}, factory, options = null }) {
  return async ({ agentId }) => {
    const c = await repo.getAgentConfig(agentId);
    if (!c) return null;
    if (c.enabled === false) return { enabled: false };

    // Runtime config: a per-cycle DB read of legion.runtime_config overlaid on the
    // env-derived cfg, so a dashboard change to the model / fallback / toggle / timeouts
    // takes effect next cycle with no redeploy. Absent rows keep the env defaults.
    const overrides = (await repo.getRuntimeConfig?.()) ?? {};
    const cfgWithOverrides = applyRuntimeOverrides(cfg, overrides);

    // Wrap factory to forward cfgWithOverrides as a second argument so tests can
    // assert the overlay without needing a live provider.
    const buildWithCfg = (opts) =>
      factory
        ? factory(opts, cfgWithOverrides)
        : createProvider(
            opts.type,
            withModel(withAgentOptions(cfgWithOverrides, options), opts.type, opts.model),
          );

    return {
      provider: resolveProvider({ provider: c.provider, model: c.model }, buildWithCfg),
      enabled: true,
    };
  };
}

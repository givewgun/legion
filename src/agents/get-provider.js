import { resolveProvider, createProvider, withAgentOptions, withModel } from '../llm/provider.js';
import { applyRuntimeOverrides } from '../config/runtime-overrides.js';

// Builds the per-cycle getProvider({ agentId }) callback the agent factory uses to
// honor runtime config. Resolution per cycle means a change saved on the dashboard
// takes effect on the next evaluation, no redeploy.
//
// Two layers of override, both read fresh every cycle:
//   - legion.runtime_config  — GLOBAL knobs (model, fallback, home-PC toggle, timeouts).
//   - legion.agent_config    — per-agent provider/model/enabled, set on the Agents tab.
//
// Returns:
//   { enabled: false } — muted agent (per-agent row with enabled=false); factory
//                        abstains (HOLD/0) without an LLM call, and no provider is
//                        constructed (so a not-yet-implemented provider name on a
//                        disabled agent never throws)
//   { provider, enabled: true } — provider built from cfg + global runtime overrides,
//                        then the per-agent provider/model on top when a row exists.
//
// Critically, a missing per-agent row must NOT short-circuit: the GLOBAL runtime
// overrides have to apply regardless, or the dashboard toggles (e.g. "Allow Oracle
// fallback") are silently ignored and the agent keeps using the static env-built
// provider. With no row we fall back to the agent's default provider (`defaultProvider`)
// and let cfg supply the model.
//
// `factory` is injectable for tests; the default routes through createProvider,
// overlaying the chosen model onto the provider's config block while preserving the
// rest of cfg (e.g. the Ollama URL and resilience options). `options` carries the
// agent's static sampling settings (temperature, seed) so a dashboard model switch
// keeps the agent's sampling persona.
export function buildGetProvider({ repo, cfg = {}, factory, options = null, defaultProvider = 'local' }) {
  return async ({ agentId }) => {
    const c = await repo.getAgentConfig(agentId);
    if (c?.enabled === false) return { enabled: false };

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

    // No per-agent row → use the agent's default provider and let cfg supply the
    // model (model: null keeps the configured/overridden model rather than clobbering
    // it with a hardcoded default).
    const provider = c?.provider ?? defaultProvider;
    const model = c?.model ?? null;
    return {
      provider: resolveProvider({ provider, model }, buildWithCfg),
      enabled: true,
    };
  };
}

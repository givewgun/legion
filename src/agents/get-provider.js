import { resolveProvider, createProvider } from '../llm/provider.js';

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
// rest of cfg (e.g. the Ollama URL and resilience options).
export function buildGetProvider({ repo, cfg = {}, factory }) {
  const build =
    factory ??
    (({ type, model }) =>
      createProvider(type, {
        ...cfg,
        ollama: { ...cfg.ollama, model: model ?? cfg.ollama?.model },
      }));

  return async ({ agentId }) => {
    const c = await repo.getAgentConfig(agentId);
    if (!c) return null;
    if (c.enabled === false) return { enabled: false };
    return {
      provider: resolveProvider({ provider: c.provider, model: c.model }, build),
      enabled: true,
    };
  };
}

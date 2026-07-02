// PC-preferred `local` provider: when the global toggle is on AND a fast readiness
// probe passes, the home PC's Ollama (primary) serves the call — and we COMMIT to it,
// queuing behind its NUM_PARALLEL slots rather than load-shedding to Oracle. The PC is
// faster than the Oracle VM, so we'd rather wait than spill a sweep onto the slow box.
// Oracle (fallback) is used only when the PC is unavailable (toggle off, asleep, busy,
// or the probe fails) — NOT as a mid-call escape hatch. A PC error therefore propagates
// (the agent abstains) and the next call re-probes, so a PC that dies mid-sweep self-
// corrects to Oracle within one probe. generate returns { text, thinking, model, source }
// so the served model/source can be tagged onto the vote for per-(agent, model)
// reliability, and a thinking model's reasoning trace rides along.
//
// `allowFallback` is the tiering switch. When false the PC is PINNED: every call goes to
// it unconditionally (no probe, no Oracle ever) — the operator wants the home PC or
// nothing, so a PC error propagates rather than silently degrading to the slow VM. Flip
// it true (HOME_FALLBACK=true) to restore the tiered probe-gated Oracle fallback.
export function createTieredProvider({
  primary,
  fallback,
  probe = async () => false,
  isEnabled = () => true,
  allowFallback = true,
}) {
  async function usePrimary() {
    if (!(await isEnabled())) return false;
    try {
      return await probe();
    } catch {
      return false; // probe failure == not ready
    }
  }

  // Tags the serving tier's model/source onto its reply, absorbing both provider
  // shapes (a plain string, or { text, thinking } from the Ollama provider).
  async function serve(tier, { system, prompt }) {
    const out = await tier.generate({ system, prompt });
    const { text, thinking = null } = typeof out === 'string' ? { text: out } : out;
    return { text, thinking, model: tier.model, source: tier.source };
  }

  return {
    name: 'local',
    get model() {
      return primary.model;
    },
    async generate({ system, prompt }) {
      // PC pinned (tiering off): always the PC, never Oracle. Error propagates.
      if (!allowFallback) return serve(primary, { system, prompt });
      // PC available → commit to it (queue, don't fail over). Error propagates.
      if (await usePrimary()) return serve(primary, { system, prompt });
      // PC unavailable → Oracle.
      return serve(fallback, { system, prompt });
    },
  };
}

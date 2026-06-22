// Tiered `local` provider: prefer the home PC's Ollama (primary) when the global
// toggle is on AND a fast readiness probe passes, else use the Oracle VM's Ollama
// (fallback). Any primary error fails over to the fallback so a PC that sleeps
// mid-sweep degrades gracefully. generate returns { text, model } so the served
// model can be tagged onto the vote for per-(agent, model) reliability.
export function createTieredProvider({
  primary,
  fallback,
  probe = async () => false,
  isEnabled = () => true,
}) {
  async function usePrimary() {
    if (!(await isEnabled())) return false;
    try {
      return await probe();
    } catch {
      return false; // probe failure == not ready
    }
  }

  return {
    name: 'local',
    get model() {
      return primary.model;
    },
    async generate({ system, prompt }) {
      if (await usePrimary()) {
        try {
          const text = await primary.generate({ system, prompt });
          return { text, model: primary.model, source: primary.source };
        } catch {
          // primary errored (timeout / transport / 5xx after its own retries) —
          // fail this call over to the always-available fallback.
        }
      }
      const text = await fallback.generate({ system, prompt });
      return { text, model: fallback.model, source: fallback.source };
    },
  };
}

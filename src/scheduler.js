// Reads enabled tickers and kicks a cycle for each. Pure orchestration — no
// consensus decision. One ticker's failure does not abort the batch.
export function createScheduler({ orchestrator, repo, logger = console }) {
  return {
    async runOnce() {
      const symbols = await repo.listEnabledTickers();
      for (const symbol of symbols) {
        try {
          await orchestrator.kick(symbol);
        } catch (err) {
          logger.error(`[scheduler] kick ${symbol} failed: ${err.message}`);
        }
      }
      return symbols;
    },
  };
}

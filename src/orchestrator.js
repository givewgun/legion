import { cycleSubject, stopSubject } from './bus/subjects.js';

// Kicks an evaluation cycle for a ticker. Round always starts at 1 in Phase 1.
export function createOrchestrator({ bus, repo }) {
  return {
    async kick(symbol) {
      const ticker = symbol.toUpperCase();
      const cycleId = await repo.createCycle(ticker);
      bus.publishJSON(cycleSubject(ticker), { cycleId, symbol: ticker, round: 1 });
      return cycleId;
    },
    // Requests a stop of any in-flight cycles for a ticker. Publish-only: the
    // emitter owns the cycle lifecycle, so it drops the buffers, closes the DB
    // rows as 'stopped', and ignores stragglers from agents mid-LLM-call.
    stop(symbol) {
      const ticker = symbol.toUpperCase();
      bus.publishJSON(stopSubject(ticker), { symbol: ticker });
    },
  };
}

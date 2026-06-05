import { cycleSubject } from './bus/subjects.js';

// Kicks an evaluation cycle for a ticker. Round always starts at 1 in Phase 1.
export function createOrchestrator({ bus, repo }) {
  return {
    async kick(symbol) {
      const ticker = symbol.toUpperCase();
      const cycleId = await repo.createCycle(ticker);
      bus.publishJSON(cycleSubject(ticker), { cycleId, symbol: ticker, round: 1 });
      return cycleId;
    },
  };
}

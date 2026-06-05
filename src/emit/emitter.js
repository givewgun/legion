import { voteWildcard, consensusSubject } from '../bus/subjects.js';
import { evaluateRound } from '../consensus/aggregate.js';
import { buildSignal } from './plan.js';
import { formatSignal } from './telegram.js';

// Collects votes per cycle and finalizes once expectedAgents have voted.
export function createEmitter({
  bus,
  repo,
  telegram,
  consensus,
  expectedAgents,
  logger = console,
}) {
  const pending = new Map(); // cycleId -> { symbol, round, votes: [] }

  async function finalize(cycleId, entry) {
    const votes = entry.votes;
    const result = evaluateRound(votes, consensus);
    const roundId = await repo.addRound(cycleId, entry.round, result);
    for (const v of votes) await repo.addVote(roundId, v);

    const signal = buildSignal(result, { symbol: entry.symbol, votes });
    await repo.addSignal(cycleId, signal);
    await repo.finishCycle(cycleId, result.converged ? 'converged' : 'no_consensus');

    try {
      await telegram(formatSignal(signal));
    } catch (err) {
      logger.error(`[emitter] telegram failed: ${err.message}`);
    }
    bus.publishJSON(consensusSubject(entry.symbol), { cycleId, ...signal });
  }

  return {
    start() {
      bus.subscribeJSON(voteWildcard(), (msg) => {
        const { cycleId, symbol, round, vote } = msg;
        if (!pending.has(cycleId)) pending.set(cycleId, { symbol, round, votes: [] });
        const entry = pending.get(cycleId);
        entry.votes.push(vote);
        if (entry.votes.length >= expectedAgents) {
          pending.delete(cycleId);
          finalize(cycleId, entry);
        }
      });
    },
  };
}

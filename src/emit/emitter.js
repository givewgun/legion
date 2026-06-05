import {
  voteWildcard,
  constraintWildcard,
  cycleSubject,
  consensusSubject,
} from '../bus/subjects.js';
import { evaluateRound } from '../consensus/aggregate.js';
import { buildSignal } from './plan.js';
import { applyRiskConstraint } from '../risk/apply.js';
import { formatSignal } from './telegram.js';

// Collects votes (+ optional risk constraint) per (cycleId, round). When the
// round is complete it persists the round, then either finalizes (converged or
// round cap) or republishes the cycle for another round with dissent.
export function createEmitter({
  bus,
  repo,
  telegram,
  consensus,
  expectedAgents,
  riskEnabled = false,
  logger = console,
}) {
  const rounds = new Map(); // `${cycleId}:${round}` -> { symbol, round, votes, constraint }

  function key(cycleId, round) {
    return `${cycleId}:${round}`;
  }

  function touch(cycleId, round, symbol) {
    const k = key(cycleId, round);
    if (!rounds.has(k)) rounds.set(k, { symbol, round, votes: [], constraint: null });
    return { k, entry: rounds.get(k) };
  }

  function ready(entry) {
    return entry.votes.length >= expectedAgents && (!riskEnabled || entry.constraint !== null);
  }

  async function process(cycleId, k, entry) {
    rounds.delete(k); // guard against double-finalize
    const result = evaluateRound(entry.votes, consensus);
    const roundId = await repo.addRound(cycleId, entry.round, result);
    for (const v of entry.votes) await repo.addVote(roundId, v);

    const isFinal = result.converged || entry.round >= consensus.maxRounds;
    if (!isFinal) {
      bus.publishJSON(cycleSubject(entry.symbol), {
        cycleId,
        symbol: entry.symbol,
        round: entry.round + 1,
        priorVotes: entry.votes,
      });
      return;
    }

    let signal = buildSignal(result, { symbol: entry.symbol, votes: entry.votes });
    if (riskEnabled) signal = applyRiskConstraint(signal, entry.constraint);
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
        const { k, entry } = touch(cycleId, round, symbol);
        entry.votes.push(vote);
        if (ready(entry)) process(cycleId, k, entry);
      });
      bus.subscribeJSON(constraintWildcard(), (msg) => {
        const { cycleId, symbol, round, constraint } = msg;
        const { k, entry } = touch(cycleId, round, symbol);
        entry.constraint = constraint;
        if (ready(entry)) process(cycleId, k, entry);
      });
    },
  };
}

import {
  voteWildcard,
  constraintWildcard,
  cycleSubject,
  consensusSubject,
} from '../bus/subjects.js';
import { evaluateRound } from '../consensus/aggregate.js';
import { scaleWeights } from '../consensus/reliability.js';
import { buildSignal } from './plan.js';
import { applyRiskConstraint } from '../risk/apply.js';
import { formatSignal } from './telegram.js';

const DAY_MS = 86400000;

// Collects votes (+ optional risk constraint) per (cycleId, round). When the
// round is complete it aggregates with reliability-scaled weights (W_i = w_i·ρ_i),
// persists the round, then either finalizes (converged or round cap) or republishes
// the cycle for another round with dissent. On finalize it snapshots the per-agent
// forecast and the entry price / resolution window for the forward paper-test.
export function createEmitter({
  bus,
  repo,
  telegram,
  consensus,
  expectedAgents,
  riskEnabled = false,
  gunvest = null,
  horizonDays = 5,
  clock = () => new Date(),
  logger = console,
}) {
  const rounds = new Map(); // `${cycleId}:${round}` -> { symbol, round, votes, constraint }
  const rhoByCycle = new Map(); // cycleId -> reliability map, loaded once per cycle

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

  async function rhoForCycle(cycleId) {
    if (!rhoByCycle.has(cycleId)) {
      rhoByCycle.set(cycleId, (await repo.getAllReliability?.()) ?? {});
    }
    return rhoByCycle.get(cycleId);
  }

  async function process(cycleId, k, entry) {
    rounds.delete(k); // guard against double-finalize

    // Aggregate with reliability-scaled weights, loaded once per cycle.
    const rhoMap = await rhoForCycle(cycleId);
    const scaled = scaleWeights(entry.votes, rhoMap);

    const result = evaluateRound(scaled, consensus);
    const roundId = await repo.addRound(cycleId, entry.round, result);
    for (const v of scaled) await repo.addVote(roundId, v);

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

    let signal = buildSignal(result, { symbol: entry.symbol, votes: scaled });
    if (riskEnabled) signal = applyRiskConstraint(signal, entry.constraint);

    const now = clock();
    const resolveAfter = new Date(now.getTime() + horizonDays * DAY_MS).toISOString();
    let entryPrice = null;
    if (gunvest) {
      try {
        const p = await gunvest.getPrice(entry.symbol);
        entryPrice = p?.price ?? null;
      } catch (err) {
        logger.error(`[emitter] entry price fetch failed for ${entry.symbol}: ${err.message}`);
      }
    }

    const signalId = await repo.addSignal(cycleId, {
      ...signal,
      entryPrice,
      horizonDays,
      resolveAfter,
    });
    await repo.addSignalVotes?.(
      signalId,
      scaled.map((v) => ({
        agentId: v.agentId,
        stance: v.stance,
        conviction: v.conviction,
        weight: v.weight,
      })),
    );
    await repo.finishCycle(cycleId, result.converged ? 'converged' : 'no_consensus');
    rhoByCycle.delete(cycleId);

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

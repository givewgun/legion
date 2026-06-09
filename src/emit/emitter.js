import {
  voteWildcard,
  constraintWildcard,
  cycleSubject,
  consensusSubject,
} from '../bus/subjects.js';
import { evaluateRound, independentBacking } from '../consensus/aggregate.js';
import { scaleWeights, scaleConviction } from '../consensus/reliability.js';
import { buildSignal } from './plan.js';
import { applyRiskConstraint } from '../risk/apply.js';
import { formatSignal } from './telegram.js';

const DAY_MS = 86400000;
// Buffered (cycleId, round) state is only freed on the happy path — a round that
// collects all expected votes, or a cycle that finalizes. A round that never
// completes (an agent process is down, a missing risk constraint, or a late
// duplicate vote re-creating a finalized entry) would otherwise pin its buffers
// forever, so we evict entries older than this. Generous vs. a real cycle
// (seconds–minutes) to never drop one still in flight.
const DefaultStaleEntryMs = 30 * 60 * 1000;
// Upper bound on how often the lazy sweep scans; the actual cadence is the min of
// this and staleEntryMs so a small staleEntryMs (tests) still sweeps promptly.
const SweepThrottleMs = 60 * 1000;

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
  staleEntryMs = DefaultStaleEntryMs,
  clock = () => new Date(),
  logger = console,
}) {
  const rounds = new Map(); // `${cycleId}:${round}` -> { symbol, round, votes, constraint, createdAt }
  const learnedByCycle = new Map(); // cycleId -> { rho, calib, corr } loaded once per cycle
  const firstVotesByCycle = new Map(); // cycleId -> round-1 votes (independent priors)
  const cycleSeenAt = new Map(); // cycleId -> ms first seen (drives stale-cycle eviction)
  const sweepThrottleMs = Math.min(SweepThrottleMs, staleEntryMs);
  let lastSweepMs = 0;

  function key(cycleId, round) {
    return `${cycleId}:${round}`;
  }

  function touch(cycleId, round, symbol, nowMs) {
    const k = key(cycleId, round);
    if (!rounds.has(k)) {
      rounds.set(k, { symbol, round, votes: [], constraint: null, createdAt: nowMs });
    }
    if (!cycleSeenAt.has(cycleId)) cycleSeenAt.set(cycleId, nowMs);
    return { k, entry: rounds.get(k) };
  }

  // Drop buffers that have lingered past staleEntryMs — a round that never reached
  // quorum and the per-cycle state of a cycle that never finalized. Bounds memory
  // regardless of which agent or constraint went missing.
  function sweepStale(nowMs) {
    let evicted = 0;
    for (const [k, entry] of rounds) {
      if (nowMs - entry.createdAt > staleEntryMs) {
        rounds.delete(k);
        evicted += 1;
      }
    }
    for (const [cycleId, seenAt] of cycleSeenAt) {
      if (nowMs - seenAt > staleEntryMs) {
        cycleSeenAt.delete(cycleId);
        learnedByCycle.delete(cycleId);
        firstVotesByCycle.delete(cycleId);
      }
    }
    if (evicted > 0) {
      logger.warn?.(
        `[emitter] evicted ${evicted} stale round buffer(s) older than ${staleEntryMs}ms — ` +
          `an agent likely never voted or a risk constraint never arrived`,
      );
    }
  }

  function maybeSweep(nowMs) {
    if (nowMs - lastSweepMs < sweepThrottleMs) return;
    lastSweepMs = nowMs;
    sweepStale(nowMs);
  }

  function ready(entry) {
    return entry.votes.length >= expectedAgents && (!riskEnabled || entry.constraint !== null);
  }

  async function learnedForCycle(cycleId) {
    if (!learnedByCycle.has(cycleId)) {
      const [rho, calib, corrMap] = await Promise.all([
        repo.getAllReliability?.() ?? {},
        repo.getAgentCalibration?.() ?? {},
        repo.getAgentCorrelations?.() ?? {},
      ]);
      // Symmetric lookup; defaults to 0 (independent) for unseen pairs.
      const corr = (a, b) => corrMap[a]?.[b] ?? 0;
      learnedByCycle.set(cycleId, { rho, calib, corr });
    }
    return learnedByCycle.get(cycleId);
  }

  async function process(cycleId, k, entry) {
    rounds.delete(k); // guard against double-finalize

    // Aggregate with reliability-scaled weights (W_i = w_i·ρ_i) and calibration-scaled
    // conviction (c'_i = c_i·cal_i), both loaded once per cycle. The round record stores
    // these effective inputs so any node recomputes the same S/V/κ (ADR 0001), while the
    // forecast snapshot below keeps RAW conviction to avoid a calibration feedback loop.
    // `corr` discounts redundant agreement in the quorum (ADR 0015).
    const { rho, calib, corr } = await learnedForCycle(cycleId);
    const scaled = scaleWeights(entry.votes, rho);
    const calibrated = scaleConviction(scaled, calib);

    const result = evaluateRound(calibrated, { ...consensus, corr });

    // Anti-herding guard (ADR 0016): the first round we see is independent — remember
    // it. A later round may only "converge" because agents flipped to match the loudest
    // peer; require that the converged side still carries enough independent round-1
    // backing, or treat it as social pressure, not agreement, and keep deliberating.
    if (!firstVotesByCycle.has(cycleId)) firstVotesByCycle.set(cycleId, calibrated);
    if (result.converged && entry.round > 1) {
      const backing = independentBacking(firstVotesByCycle.get(cycleId), Math.sign(result.S));
      const priorQuorum = consensus.priorQuorum ?? 0;
      if (backing < priorQuorum) {
        result.converged = false;
        logger.info?.(
          `[emitter] herding guard: ${entry.symbol} round ${entry.round} blocked ` +
            `(independent backing ${backing.toFixed(2)} < ${priorQuorum})`,
        );
      }
    }

    const roundId = await repo.addRound(cycleId, entry.round, result);
    for (const v of calibrated) await repo.addVote(roundId, v);

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

    let signal = buildSignal(result, { symbol: entry.symbol, votes: calibrated });
    if (riskEnabled) signal = applyRiskConstraint(signal, entry.constraint);

    const now = clock();
    const resolveAfter = new Date(now.getTime() + horizonDays * DAY_MS).toISOString();
    // Capture the stock and its benchmarks in the same instant so the forward
    // paper-test measures all three from a shared "entered at signal time" base
    // (ADR 0009). All-or-nothing: if any leg fails the resolver falls back to a
    // consistent close-to-close window rather than mixing bases.
    let entryPrice = null;
    let spyEntryPrice = null;
    let qqqEntryPrice = null;
    if (gunvest) {
      try {
        const [p, spy, qqq] = await Promise.all([
          gunvest.getPrice(entry.symbol),
          gunvest.getPrice('SPY'),
          gunvest.getPrice('QQQ'),
        ]);
        entryPrice = p?.price ?? null;
        spyEntryPrice = spy?.price ?? null;
        qqqEntryPrice = qqq?.price ?? null;
      } catch (err) {
        logger.error(`[emitter] entry price fetch failed for ${entry.symbol}: ${err.message}`);
      }
    }

    const signalId = await repo.addSignal(cycleId, {
      ...signal,
      entryPrice,
      spyEntryPrice,
      qqqEntryPrice,
      horizonDays,
      resolveAfter,
    });
    // Snapshot RAW self-reported conviction (from `scaled`, which leaves conviction
    // untouched) so the calibration learner scores what the agent actually claimed.
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
    learnedByCycle.delete(cycleId);
    firstVotesByCycle.delete(cycleId);
    cycleSeenAt.delete(cycleId);

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
        const nowMs = clock().getTime();
        maybeSweep(nowMs);
        const { cycleId, symbol, round, vote } = msg;
        const { k, entry } = touch(cycleId, round, symbol, nowMs);
        entry.votes.push(vote);
        if (ready(entry)) process(cycleId, k, entry);
      });
      bus.subscribeJSON(constraintWildcard(), (msg) => {
        const nowMs = clock().getTime();
        maybeSweep(nowMs);
        const { cycleId, symbol, round, constraint } = msg;
        const { k, entry } = touch(cycleId, round, symbol, nowMs);
        entry.constraint = constraint;
        if (ready(entry)) process(cycleId, k, entry);
      });
    },
    // Read-only buffer sizes for observability / leak detection (e.g. a health
    // metric). Bounded in steady state; unbounded growth signals a missing agent.
    stats() {
      return { pendingRounds: rounds.size, pendingCycles: cycleSeenAt.size };
    },
  };
}

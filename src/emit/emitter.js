import {
  voteWildcard,
  constraintWildcard,
  cycleSubject,
  consensusSubject,
} from '../bus/subjects.js';
import { evaluateRound, independentBacking } from '../consensus/aggregate.js';
import { scaleWeights, scaleConviction } from '../consensus/reliability.js';
import { classifyRegime } from '../reliability/regime.js';
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
  const cycleSeenAt = new Map(); // cycleId -> ms of last activity (drives stale-cycle eviction)
  const sweepThrottleMs = Math.min(SweepThrottleMs, staleEntryMs);
  let lastSweepMs = 0;

  function key(cycleId, round) {
    return `${cycleId}:${round}`;
  }

  function touch(cycleId, round, symbol, nowMs) {
    const k = key(cycleId, round);
    if (!rounds.has(k)) {
      rounds.set(k, { cycleId, symbol, round, votes: [], constraint: null, createdAt: nowMs });
    }
    // Refresh on every message so the cycle's age tracks *last activity*, not
    // first-seen — otherwise a slow multi-round cycle whose total span exceeds
    // staleEntryMs would have its independent round-1 priors swept mid-flight.
    cycleSeenAt.set(cycleId, nowMs);
    return { k, entry: rounds.get(k) };
  }

  // Crash recovery (ADR 0024): every arriving vote/constraint is also persisted
  // to a pending table (fire-and-forget — the hot path never blocks on it). On
  // start, anything younger than staleEntryMs is reloaded: in-flight buffers are
  // rebuilt (deduped by agentId against any votes that raced in live), round-1
  // priors are restored for the herding guard, rounds already aggregated before
  // the crash are skipped, and any round that is now complete is processed.
  async function recover() {
    if (!repo.loadPendingVotes) return;
    const nowMs = clock().getTime();
    const cutoff = new Date(nowMs - staleEntryMs).toISOString();
    const [pendingVotes, pendingConstraints] = await Promise.all([
      repo.loadPendingVotes(cutoff),
      repo.loadPendingConstraints?.(cutoff) ?? [],
    ]);
    const firstVotes = new Map(); // cycleId -> round-1 votes
    for (const row of pendingVotes) {
      const { entry } = touch(row.cycle_id, row.round, row.symbol, nowMs);
      if (!entry.votes.some((v) => v.agentId === row.vote.agentId)) entry.votes.push(row.vote);
      if (row.round === 1) {
        if (!firstVotes.has(row.cycle_id)) firstVotes.set(row.cycle_id, []);
        firstVotes.get(row.cycle_id).push(row.vote);
      }
    }
    for (const [cycleId, votes] of firstVotes) {
      if (!firstVotesByCycle.has(cycleId)) firstVotesByCycle.set(cycleId, votes);
    }
    for (const row of pendingConstraints) {
      const { entry } = touch(row.cycle_id, row.round, row.symbol, nowMs);
      entry.constraint = row.payload;
    }
    let resumed = 0;
    for (const [k, entry] of [...rounds]) {
      if (!ready(entry)) continue; // still waiting on votes; live subscription fills in
      if (await repo.roundExists?.(entry.cycleId, entry.round)) {
        // Aggregated before the crash — only its (already republished or
        // finalized) successors matter; drop the buffer, keep the priors.
        rounds.delete(k);
        continue;
      }
      resumed += 1;
      await process(entry.cycleId, k, entry);
    }
    if (pendingVotes.length > 0) {
      logger.info?.(
        `[emitter] recovered ${pendingVotes.length} pending vote(s), resumed ${resumed} round(s)`,
      );
    }
  }

  // Drop buffers that have lingered past staleEntryMs — a round that never reached
  // quorum and the per-cycle state of a cycle that never finalized. Bounds memory
  // regardless of which agent or constraint went missing. Pending rows age out on
  // the same horizon so an abandoned cycle cannot resurrect on the next restart.
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
    repo
      .deletePendingBefore?.(new Date(nowMs - staleEntryMs).toISOString())
      .catch((err) => logger.error(`[emitter] pending sweep failed: ${err.message}`));
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

  // Current market regime (calm | stressed | unknown, from VIX), per cycle.
  // 'unknown' (no macro source, or a fetch failure) means the regime overlay
  // is skipped and the unconditional dials apply (ADR 0023).
  async function detectRegime() {
    if (!gunvest?.getMacro) return 'unknown';
    try {
      return classifyRegime((await gunvest.getMacro())?.vix);
    } catch {
      return 'unknown';
    }
  }

  async function learnedForCycle(cycleId) {
    if (!learnedByCycle.has(cycleId)) {
      const regime = await detectRegime();
      const conditioned = regime !== 'unknown';
      const [rho, calibration, info, corrMap, regimeRho, regimeCal] = await Promise.all([
        repo.getAllReliability?.() ?? {},
        repo.getAgentCalibration?.() ?? {},
        repo.getAgentInfoFactors?.() ?? {},
        repo.getAgentCorrelations?.() ?? {},
        (conditioned ? repo.getRegimeReliability?.(regime) : null) ?? {},
        (conditioned ? repo.getRegimeCalibration?.(regime) : null) ?? {},
      ]);
      // Regime overlay (ADR 0023): per-(agent, regime) dials override the
      // unconditional ones where a deep-enough bucket exists (the learner only
      // persists such buckets), so "News is 1.4x in stressed tape, 0.8x in calm"
      // beats one averaged number.
      const rhoEff = { ...rho, ...regimeRho };
      const calEff = { ...calibration, ...regimeCal };
      // The conviction term is scaled by calibration × information factor: cal
      // asks "is its confidence meaningful", info asks "is anyone home" (a
      // near-constant voter is discounted until its stances move — ADR 0021).
      const calib = {};
      for (const agentId of new Set([...Object.keys(calEff), ...Object.keys(info)])) {
        calib[agentId] = (calEff[agentId] ?? 1.0) * (info[agentId] ?? 1.0);
      }
      // Symmetric lookup; defaults to 0 (independent) for unseen pairs.
      const corr = (a, b) => corrMap[a]?.[b] ?? 0;
      learnedByCycle.set(cycleId, { rho: rhoEff, calib, corr, regime });
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
    const { rho, calib, corr, regime } = await learnedForCycle(cycleId);
    const scaled = scaleWeights(entry.votes, rho);
    const calibrated = scaleConviction(scaled, calib);

    const result = evaluateRound(calibrated, { ...consensus, corr });

    // Anti-herding guard (ADR 0016): the first round we see is independent — remember
    // it. A later round may only "converge" because agents flipped to match the loudest
    // peer; require that the converged side still carries enough independent round-1
    // backing, or treat it as social pressure, not agreement, and keep deliberating.
    // RAW votes are stored (not the calibrated copies): "independent backing" means the
    // agents' own pre-dissent claims, and raw votes are what the pending table can
    // restore after a crash (ADR 0024).
    if (!firstVotesByCycle.has(cycleId)) firstVotesByCycle.set(cycleId, entry.votes);
    if (result.converged && entry.round > 1) {
      const priors = firstVotesByCycle.get(cycleId);
      const backing = independentBacking(priors, Math.sign(result.S));
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
      // Mark activity at republish so the next round gets a full staleEntryMs
      // window to arrive before this cycle's priors are considered abandoned.
      cycleSeenAt.set(cycleId, clock().getTime());
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
      // The regime the panel decided in — lets the learner grade each forecast
      // in its own regime bucket (ADR 0023).
      regime,
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
    // The cycle is finalized — its pending rows have served their purpose.
    await repo.deletePendingCycle?.(cycleId).catch((err) => {
      logger.error(`[emitter] pending cleanup failed for cycle ${cycleId}: ${err.message}`);
    });

    try {
      await telegram(formatSignal(signal));
    } catch (err) {
      logger.error(`[emitter] telegram failed: ${err.message}`);
    }
    bus.publishJSON(consensusSubject(entry.symbol), { cycleId, ...signal });
  }

  return {
    // Subscribes immediately (no live message is missed), then replays pending
    // state from before a crash. Returns the recovery promise so callers and
    // tests can await a fully-restored emitter; live traffic needs no await.
    start() {
      bus.subscribeJSON(voteWildcard(), (msg) => {
        const nowMs = clock().getTime();
        maybeSweep(nowMs);
        const { cycleId, symbol, round, vote } = msg;
        const { k, entry } = touch(cycleId, round, symbol, nowMs);
        entry.votes.push(vote);
        // Fire-and-forget: crash recovery is best-effort, the hot path is not.
        repo.savePendingVote?.(cycleId, round, symbol, vote).catch((err) => {
          logger.error(`[emitter] pending vote persist failed: ${err.message}`);
        });
        if (ready(entry)) process(cycleId, k, entry);
      });
      bus.subscribeJSON(constraintWildcard(), (msg) => {
        const nowMs = clock().getTime();
        maybeSweep(nowMs);
        const { cycleId, symbol, round, constraint } = msg;
        const { k, entry } = touch(cycleId, round, symbol, nowMs);
        entry.constraint = constraint;
        repo.savePendingConstraint?.(cycleId, round, symbol, constraint).catch((err) => {
          logger.error(`[emitter] pending constraint persist failed: ${err.message}`);
        });
        if (ready(entry)) process(cycleId, k, entry);
      });
      return recover().catch((err) => {
        logger.error(`[emitter] crash recovery failed: ${err.message}`);
      });
    },
    // Read-only buffer sizes for observability / leak detection (e.g. a health
    // metric). Bounded in steady state; unbounded growth signals a missing agent.
    stats() {
      return { pendingRounds: rounds.size, pendingCycles: cycleSeenAt.size };
    },
  };
}

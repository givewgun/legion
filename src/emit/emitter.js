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

// Overlays regime-conditional nested dials onto the unconditional ones at the
// (agent, model) leaf: a deep-enough regime bucket overrides the base value,
// otherwise the base survives. Mirrors the old `{...rho, ...regimeRho}` spread
// but one level deeper now that dials are keyed by (agent, model).
function mergeNested(base, overlay) {
  const out = {};
  for (const agentId of new Set([...Object.keys(base), ...Object.keys(overlay)])) {
    out[agentId] = { ...(base[agentId] ?? {}), ...(overlay[agentId] ?? {}) };
  }
  return out;
}

const DAY_MS = 86400000;
// Buffered (cycleId, round) state is only freed on the happy path — a round that
// collects all expected votes, or a cycle that finalizes. A round that never
// completes (an agent process is down, a missing risk constraint, or a late
// duplicate vote re-creating a finalized entry) would otherwise pin its buffers
// forever, so we evict entries this long after their LAST activity. Age since
// last message, not since creation: a saturated LLM box legitimately spreads one
// round's votes over more than this window (a 13-ticker batch through a serial
// ollama queue), and evicting mid-round discards the votes already collected and
// the risk constraint — which is published once per round and never re-sent —
// leaving the cycle unable to ever complete.
const DefaultStaleEntryMs = 90 * 60 * 1000;
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
  const rounds = new Map(); // `${cycleId}:${round}` -> { symbol, round, votes, constraint, lastSeenAt }
  const learnedByCycle = new Map(); // cycleId -> { rhoLookup, calibLookup, corr, regime } loaded once per cycle
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
      rounds.set(k, { cycleId, symbol, round, votes: [], constraint: null, lastSeenAt: nowMs });
    }
    // Refresh on every message so staleness tracks *last activity*, not
    // first-seen — otherwise a slow round (or a multi-round cycle) whose total
    // span exceeds staleEntryMs would be swept mid-flight.
    const entry = rounds.get(k);
    entry.lastSeenAt = nowMs;
    cycleSeenAt.set(cycleId, nowMs);
    return { k, entry };
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
        // Aggregated before the crash — but the crash may have landed BETWEEN
        // persisting the round and acting on it (republishing the next round,
        // or emitting the final signal). Replay whichever action is missing
        // instead of dropping the buffer and stranding the cycle.
        rounds.delete(k);
        await resumeAfterRound(entry);
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
    // Cycles too old to recover (their pending rows aged out) can never finish
    // on their own — sweep now so they are closed as 'timeout' instead of
    // sitting in 'running' until the next batch's traffic triggers a sweep.
    lastSweepMs = nowMs;
    sweepStale(nowMs);
  }

  // A round that was persisted before the crash had exactly one pending action:
  // a non-final round republishes round+1; a final round emits the signal and
  // finishes the cycle. If the crash swallowed that action the cycle is stuck —
  // its agents will never re-vote on their own. Determine which action is
  // missing from the persisted state and replay it.
  async function resumeAfterRound(entry) {
    const { cycleId, round, symbol } = entry;
    // Without a cycle-state surface we cannot tell what completed — keep the
    // priors and leave the cycle alone (the pre-resume conservative behaviour).
    if (!repo.getCycle || !repo.getRounds) return;
    const cycle = await repo.getCycle(cycleId);
    if (!cycle) return;
    if (cycle.status !== 'running') {
      // Finalized before the crash; only the pending rows are left to tidy.
      await cleanupCycle(cycleId);
      return;
    }
    const roundRow = ((await repo.getRounds(cycleId)) ?? []).find(
      (r) => Number(r.round_no) === round,
    );
    if (!roundRow) return;
    const converged = roundRow.converged === true;
    const isFinal = converged || round >= consensus.maxRounds;

    if (!isFinal) {
      // The missing action was the round+1 republish. Even if it DID go out,
      // the agents' replies were published into a dead subscription and are
      // gone — re-kicking the round is correct in both cases. Drop any partial
      // pre-crash round+1 buffer so the fresh votes form a clean round.
      rounds.delete(key(cycleId, round + 1));
      cycleSeenAt.set(cycleId, clock().getTime());
      bus.publishJSON(cycleSubject(symbol), {
        cycleId,
        symbol,
        round: round + 1,
        priorVotes: entry.votes,
      });
      logger.info?.(
        `[emitter] resumed ${symbol} cycle ${cycleId}: re-published round ${round + 1} after crash`,
      );
      return;
    }

    // Final round persisted but the cycle never finished. If the signal already
    // landed (crash between addSignal and finishCycle), just complete the cycle
    // — never emit twice.
    if (await repo.cycleHasSignal?.(cycleId)) {
      await repo.finishCycle(cycleId, converged ? 'converged' : 'no_consensus');
      await cleanupCycle(cycleId);
      logger.info?.(`[emitter] resumed ${symbol} cycle ${cycleId}: closed already-emitted signal`);
      return;
    }
    // Replay the finalize tail. The persisted round votes ARE the calibrated
    // aggregation inputs (ADR 0001's replication property — any node recomputes
    // the same S/V/κ from them), and the recorded `converged` already reflects
    // the herding guard's pre-crash decision, so it is honored, not re-derived.
    const { rhoLookup, corr } = await learnedForCycle(cycleId);
    const calibrated = ((await repo.getVotes?.(roundRow.id)) ?? []).map((v) => ({
      agentId: v.agent_id,
      stance: Number(v.stance),
      conviction: Number(v.conviction),
      weight: Number(v.weight),
      rationale: v.rationale ?? '',
    }));
    if (calibrated.length === 0) return;
    const result = evaluateRound(calibrated, { ...consensus, corr });
    result.converged = converged;
    const scaled = scaleWeights(entry.votes, rhoLookup);
    await finalize(cycleId, entry, result, calibrated, scaled);
    logger.info?.(
      `[emitter] resumed ${symbol} cycle ${cycleId}: emitted final round ${round} after crash`,
    );
  }

  // Frees all per-cycle state and the cycle's pending rows.
  async function cleanupCycle(cycleId) {
    learnedByCycle.delete(cycleId);
    firstVotesByCycle.delete(cycleId);
    cycleSeenAt.delete(cycleId);
    await repo.deletePendingCycle?.(cycleId).catch((err) => {
      logger.error(`[emitter] pending cleanup failed for cycle ${cycleId}: ${err.message}`);
    });
  }

  // Drop buffers that have been silent past staleEntryMs — a round that never
  // reached quorum and the per-cycle state of a cycle that never finalized.
  // Bounds memory regardless of which agent or constraint went missing. Pending
  // rows age out on the same horizon — but per CYCLE (repo.deletePendingBefore
  // spares every row of a cycle with any recent row), so a slow-but-alive
  // cycle's early votes and one-shot risk constraint stay recoverable while an
  // abandoned cycle cannot resurrect on the next restart. Evicting a buffer
  // abandons its cycle, so the matching DB rows are closed as 'timeout' too —
  // otherwise they sit in 'running' forever.
  function sweepStale(nowMs) {
    const cutoff = new Date(nowMs - staleEntryMs).toISOString();
    let evicted = 0;
    for (const [k, entry] of rounds) {
      if (nowMs - entry.lastSeenAt > staleEntryMs) {
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
    // Close abandoned cycles in the DB: still 'running', older than the stale
    // horizon, and no longer tracked in memory. Cycles still in cycleSeenAt are
    // alive however long ago they started (slow multi-round debates) and are
    // passed as protected. Also catches strays from before a restart that
    // recovery skipped as too old.
    repo
      .timeoutStaleCycles?.(cutoff, [...cycleSeenAt.keys()])
      .then((timedOut) => {
        if (timedOut?.length > 0) {
          const names = timedOut.map((c) => `${c.symbol}#${c.id}`).join(', ');
          logger.warn?.(
            `[emitter] timed out ${timedOut.length} abandoned running cycle(s): ${names}`,
          );
        }
      })
      .catch((err) => logger.error(`[emitter] stale cycle timeout failed: ${err.message}`));
    repo
      .deletePendingBefore?.(cutoff)
      .catch((err) => logger.error(`[emitter] pending sweep failed: ${err.message}`));
    if (evicted > 0) {
      logger.warn?.(
        `[emitter] evicted ${evicted} stale round buffer(s) silent for ${staleEntryMs}ms — ` +
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
      // Regime overlay (ADR 0023): per-(agent, model, regime) dials override the
      // unconditional ones where a deep-enough bucket exists (the learner only
      // persists such buckets), so "News is 1.4x in stressed tape, 0.8x in calm"
      // beats one averaged number. Dials are now keyed by (agent, model) —
      // mergeNested overlays at the model level rather than the agent level.
      const rhoEff = mergeNested(rho, regimeRho);
      const calEff = mergeNested(calibration, regimeCal);
      // Conviction term = calibration × information factor, per (agent, model).
      // cal asks "is its confidence meaningful", info asks "is anyone home" (a
      // near-constant voter is discounted until its stances move — ADR 0021).
      const calibLookup = (agentId, model) => {
        const cal = calEff[agentId]?.[model] ?? 1.0;
        const inf = info[agentId]?.[model] ?? 1.0;
        return cal * inf;
      };
      const rhoLookup = (agentId, model) => rhoEff[agentId]?.[model] ?? 1.0;
      // Symmetric lookup; defaults to 0 (independent) for unseen pairs.
      const corr = (a, b) => corrMap[a]?.[b] ?? 0;
      learnedByCycle.set(cycleId, { rhoLookup, calibLookup, corr, regime });
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
    const { rhoLookup, calibLookup, corr } = await learnedForCycle(cycleId);
    const scaled = scaleWeights(entry.votes, rhoLookup);
    const calibrated = scaleConviction(scaled, calibLookup);

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

    await finalize(cycleId, entry, result, calibrated, scaled);
  }

  // The finalize tail of a final round: build the signal, apply risk, capture
  // entry prices, persist the signal + RAW forecast snapshot, finish the cycle,
  // notify. Shared by the live path (process) and crash recovery
  // (resumeAfterRound), which replays it when a crash swallowed it (ADR 0024).
  async function finalize(cycleId, entry, result, calibrated, scaled) {
    const { regime } = await learnedForCycle(cycleId);

    let signal = buildSignal(result, { symbol: entry.symbol, votes: calibrated });
    if (riskEnabled) {
      if (entry.constraint) {
        signal = applyRiskConstraint(signal, entry.constraint);
      } else {
        // Only reachable on recovery (ready() guarantees a constraint live):
        // the pending constraint row was lost — emit unconstrained, loudly.
        logger.warn?.(
          `[emitter] finalizing ${entry.symbol} cycle ${cycleId} without a risk constraint (lost in crash)`,
        );
      }
    }

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
        model: v.model ?? null,
      })),
    );
    await repo.finishCycle(cycleId, result.converged ? 'converged' : 'no_consensus');
    // The cycle is finalized — free its state and its pending rows.
    await cleanupCycle(cycleId);

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

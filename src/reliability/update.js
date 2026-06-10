import {
  forecastProb,
  brier,
  gradedOutcome,
  reliabilityFromBrier,
  calibrationFromSamples,
  boundCombined,
  directionalHit,
  decayWeights,
  weightedMean,
  effectiveSampleSize,
  stanceVariance,
  informationFactor,
  MIN_RESOLVED,
  WINDOW,
} from '../consensus/reliability.js';
import { REGIMES } from './regime.js';

// ρ and calibration for one agent's window of resolved forecasts (rows
// newest-first). ρ scores against the magnitude-aware graded outcome (alpha vs
// SPY mapped to [0,1]) when the resolved returns are present; legacy rows
// without returns fall back to the binary outcome. The baseline is the
// uninformative p = 0.5 forecaster over the same outcomes, so the skill score
// stays centered at ρ = 1 regardless of how outcomes distribute (ADR 0018).
// Calibration keeps the BINARY hit/miss: its discriminator needs two classes.
// The combined ρ·cal influence is capped so one streaky agent cannot compound
// the dials into panel dominance (ADR 0019).
function computeDials(agentRows, weights = decayWeights(agentRows.length)) {
  const outcomes = agentRows.map((r) => gradedOutcome(r.forward_return, r.spy_return) ?? r.outcome);
  const briers = agentRows.map((r, i) => brier(forecastProb(r.stance, r.conviction), outcomes[i]));
  const baselines = outcomes.map((g) => brier(0.5, g));
  const meanBrier = weightedMean(briers, weights);
  const baselineBrier = weightedMean(baselines, weights);
  const ess = effectiveSampleSize(weights);
  const rho = reliabilityFromBrier(meanBrier, briers.length, baselineBrier, ess);

  const samples = agentRows
    .map((r, i) => ({
      conviction: r.conviction,
      hit: directionalHit(r.stance, r.outcome),
      weight: weights[i],
    }))
    .filter((s) => s.hit !== null);
  const calibration = calibrationFromSamples(samples);

  const bounded = boundCombined(rho, calibration);
  return { rho: bounded.rho, calibration: bounded.calibration, weights };
}

// Lifetime-ish horizon backing the learned domain prior (ADR 0027) — far wider
// than the recency WINDOW so it estimates the agent's standing skill, not its
// current form.
const LONG_WINDOW = 400;

// Roster watch (ADR 0028): rho at or below this counts as "pinned at the floor"
// (the floor is 0.5; a small epsilon tolerates float noise) …
export const ROSTER_FLOOR_EPS = 0.55;
// … and this many consecutive floored recomputes raises the review flag. At the
// 12h cron cadence that is ~3 days of sustained anti-skill, not one bad batch.
export const ROSTER_FLAG_AFTER = 6;

// Groups rows per agent, newest-first, capped at `cap` each. `pick` filters
// which rows enter the bucket (e.g. a regime).
function bucketByAgent(rows, pick = () => true, cap = WINDOW) {
  const byAgent = new Map();
  for (const r of rows) {
    if (!pick(r)) continue;
    if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, []);
    const bucket = byAgent.get(r.agent_id);
    if (bucket.length < cap) bucket.push(r);
  }
  return byAgent;
}

// Recompute, per agent, the learned dials from its trailing window of resolved
// forecasts: rho (skill — scales the prior w_i), calibration (is its conviction
// informative — scales the conviction term c_i), and the information factor (is
// it actually reading the data — ADR 0021). All recency-weighted so the panel
// tracks regime shifts. Also recomputes per-(agent, regime) dials (ADR 0023),
// persisting only buckets deep enough to learn from so the emitter's overlay
// falls back to the unconditional dials elsewhere. getResolvedForecasts returns
// rows newest-first, so decay weight index 0 is the most recent. Returns
// { agentId: { rho, calibration, info } }.
export async function recomputeReliability(repo, logger = console) {
  const rows = await repo.getResolvedForecasts(WINDOW * 8); // headroom for many agents
  const streaks = (await repo.getFlooredStreaks?.()) ?? {};
  const map = {};
  for (const [agentId, agentRows] of bucketByAgent(rows)) {
    const { rho, calibration, weights } = computeDials(agentRows);

    // Information check (ADR 0021): a near-constant voter is invisible to Brier
    // and correlation alike; discount its conviction until its stances move.
    const info = informationFactor(
      stanceVariance(
        agentRows.map((r) => r.stance),
        weights,
      ),
      agentRows.length,
    );

    map[agentId] = { rho, calibration, info };
    await repo.upsertReliability(agentId, rho, agentRows.length, calibration, info);

    // Roster watch (ADR 0028): an agent pinned at the rho floor recompute after
    // recompute is flagged for human review — never auto-retired. Any recovery
    // above the floor resets the streak and clears the flag.
    const streak = rho <= ROSTER_FLOOR_EPS ? (streaks[agentId] ?? 0) + 1 : 0;
    const flagged = streak >= ROSTER_FLAG_AFTER;
    map[agentId].flooredStreak = streak;
    map[agentId].flagged = flagged;
    if (flagged) {
      logger.warn?.(
        `[reliability] ${agentId} has been at the rho floor for ${streak} recomputes — review it on the Agents tab`,
      );
    }
    await repo.updateRosterFlag?.(agentId, streak, flagged);
  }

  // Learned domain prior (ADR 0027): the same skill score over a long, UNIFORM
  // window — the number the hand-set w_i is guessing at. Measure-first: it is
  // persisted and surfaced on the leaderboard but NOT yet folded into weights;
  // the question "should w_i drift toward it" waits on this data.
  for (const [agentId, longRows] of bucketByAgent(rows, () => true, LONG_WINDOW)) {
    const uniform = longRows.map(() => 1);
    const { rho: learnedPrior } = computeDials(longRows, uniform);
    if (map[agentId]) map[agentId].learnedPrior = learnedPrior;
    await repo.upsertLearnedPrior?.(agentId, learnedPrior);
  }

  // Per-regime dials (ADR 0023): same machinery over each regime's slice.
  // Buckets below MIN_RESOLVED are skipped (not persisted as neutral) so the
  // emitter's regime overlay only ever overrides with real evidence.
  for (const regime of REGIMES) {
    for (const [agentId, agentRows] of bucketByAgent(rows, (r) => r.regime === regime)) {
      if (agentRows.length < MIN_RESOLVED) continue;
      const { rho, calibration } = computeDials(agentRows);
      await repo.upsertRegimeReliability?.(agentId, regime, rho, agentRows.length, calibration);
    }
  }
  return map;
}

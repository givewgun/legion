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
  WINDOW,
} from '../consensus/reliability.js';

// Recompute, per agent, both learned weights from its trailing window of resolved
// forecasts: rho (skill, via Brier — scales the prior w_i) and calibration (is its
// conviction informative — scales the conviction term c_i). Both are recency-weighted
// (newest forecasts count most) so the panel tracks regime shifts. getResolvedForecasts
// returns rows newest-first, so decay weight index 0 is the most recent. Persists both
// and returns { agentId: { rho, calibration } }.
export async function recomputeReliability(repo) {
  const rows = await repo.getResolvedForecasts(WINDOW * 8); // headroom for many agents
  const byAgent = new Map();
  for (const r of rows) {
    if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, []);
    const bucket = byAgent.get(r.agent_id);
    if (bucket.length < WINDOW) bucket.push(r);
  }
  const map = {};
  for (const [agentId, agentRows] of byAgent) {
    const weights = decayWeights(agentRows.length);
    // ρ scores against the magnitude-aware graded outcome (alpha vs SPY mapped to
    // [0,1]) when the resolved returns are present; legacy rows without returns
    // fall back to the binary outcome. The baseline is the uninformative p = 0.5
    // forecaster over the same outcomes, so the skill score stays centered at
    // ρ = 1 regardless of how the graded outcomes are distributed (ADR 0018).
    const outcomes = agentRows.map(
      (r) => gradedOutcome(r.forward_return, r.spy_return) ?? r.outcome,
    );
    const briers = agentRows.map((r, i) =>
      brier(forecastProb(r.stance, r.conviction), outcomes[i]),
    );
    const baselines = outcomes.map((g) => brier(0.5, g));
    const meanBrier = weightedMean(briers, weights);
    const baselineBrier = weightedMean(baselines, weights);
    const ess = effectiveSampleSize(weights);
    const rho = reliabilityFromBrier(meanBrier, briers.length, baselineBrier, ess);

    // Calibration keeps the BINARY hit/miss: its discriminator needs two classes
    // (mean conviction on hits vs misses), which a graded outcome would dissolve.
    const samples = agentRows
      .map((r, i) => ({
        conviction: r.conviction,
        hit: directionalHit(r.stance, r.outcome),
        weight: weights[i],
      }))
      .filter((s) => s.hit !== null);
    const calibration = calibrationFromSamples(samples);

    // Cap the combined ρ·cal influence so one streaky agent cannot compound the
    // two dials into panel dominance (ADR 0019).
    const bounded = boundCombined(rho, calibration);

    // Information check (ADR 0021): a near-constant voter is invisible to Brier
    // and correlation alike; discount its conviction until its stances move.
    const info = informationFactor(
      stanceVariance(
        agentRows.map((r) => r.stance),
        weights,
      ),
      agentRows.length,
    );

    map[agentId] = { rho: bounded.rho, calibration: bounded.calibration, info };
    await repo.upsertReliability(agentId, bounded.rho, briers.length, bounded.calibration, info);
  }
  return map;
}

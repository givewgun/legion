import {
  forecastProb,
  brier,
  reliabilityFromBrier,
  calibrationFromSamples,
  directionalHit,
  decayWeights,
  weightedMean,
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
    const briers = agentRows.map((r) => brier(forecastProb(r.stance, r.conviction), r.outcome));
    const meanBrier = weightedMean(briers, weights);
    const rho = reliabilityFromBrier(meanBrier, briers.length);

    const samples = agentRows
      .map((r, i) => ({
        conviction: r.conviction,
        hit: directionalHit(r.stance, r.outcome),
        weight: weights[i],
      }))
      .filter((s) => s.hit !== null);
    const calibration = calibrationFromSamples(samples);

    map[agentId] = { rho, calibration };
    await repo.upsertReliability(agentId, rho, briers.length, calibration);
  }
  return map;
}

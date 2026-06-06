import { forecastProb, brier, reliabilityFromBrier, WINDOW } from '../consensus/reliability.js';

export async function recomputeReliability(repo) {
  const rows = await repo.getResolvedForecasts(WINDOW * 8); // headroom for many agents
  const byAgent = new Map();
  for (const r of rows) {
    if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, []);
    const bucket = byAgent.get(r.agent_id);
    if (bucket.length < WINDOW) {
      bucket.push(brier(forecastProb(r.stance, r.conviction), r.outcome));
    }
  }
  const map = {};
  for (const [agentId, briers] of byAgent) {
    const meanBrier = briers.reduce((a, b) => a + b, 0) / briers.length;
    const rho = reliabilityFromBrier(meanBrier, briers.length);
    map[agentId] = rho;
    await repo.upsertReliability(agentId, rho, briers.length);
  }
  return map;
}

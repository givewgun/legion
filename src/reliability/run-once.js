import { resolveSignals } from './resolver.js';
import { recomputeReliability } from './update.js';
import { recomputeCorrelations } from './correlations.js';
import { reflectAgents } from './reflect.js';

// One learning pass: resolve every due signal against forward/benchmark returns,
// recompute each agent's reliability ρ and calibration from its resolved forecasts,
// then recompute pairwise vote correlations for the quorum redundancy discount.
// When a reflection provider is supplied (LEGION_REFLECTION=true), a final pass
// distills each agent's recent misses into a lesson for its future prompts
// (ADR 0026) — strictly additive, never a reason the core steps fail.
// Shared by the reliability cron runner and the dashboard's on-demand relearn.
export async function runReliabilityOnce({
  repo,
  gunvest,
  reflectionProvider = null,
  clock = () => new Date(),
  logger = console,
}) {
  const now = clock().toISOString();
  const resolved = await resolveSignals(repo, gunvest, now);
  const reliability = await recomputeReliability(repo);
  const correlations = await recomputeCorrelations(repo);
  let lessons = 0;
  if (reflectionProvider) {
    lessons = await reflectAgents({
      repo,
      provider: reflectionProvider,
      agentIds: Object.keys(reliability),
      logger,
    });
  }
  return { resolved, reliability, correlations: correlations.length, lessons };
}

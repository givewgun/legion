import cron from 'node-cron';
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createGunvestFromConfig } from '../data/gunvest.js';
import { createProvider } from '../llm/provider.js';
import { resolveSignals } from '../reliability/resolver.js';
import { recomputeReliability } from '../reliability/update.js';
import { recomputeCorrelations } from '../reliability/correlations.js';
import { reflectAgents } from '../reliability/reflect.js';

// One pass: resolve every due signal against forward/benchmark returns, recompute
// each agent's reliability ρ and calibration from its resolved forecasts, then
// recompute pairwise vote correlations for the quorum redundancy discount.
// When a reflection provider is supplied (LEGION_REFLECTION=true), a final pass
// distills each agent's recent misses into a lesson for its future prompts
// (ADR 0026) — strictly additive, never a reason the core steps fail.
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

function main() {
  const cfg = loadConfig();
  const repo = createRepo(connectDb(cfg.databaseUrl));
  const gunvest = createGunvestFromConfig(cfg);
  const reflectionProvider = cfg.reflectionEnabled ? createProvider('local', cfg) : null;
  const runner = () =>
    runReliabilityOnce({ repo, gunvest, reflectionProvider })
      .then((s) =>
        console.log(`[reliability] resolved=${s.resolved} lessons=${s.lessons}`, s.reliability),
      )
      .catch((err) => console.error(`[reliability] run failed: ${err.message}`));

  if (process.argv.includes('--now')) {
    runner();
    return;
  }
  cron.schedule(cfg.reliabilityCron, runner);
  console.log(`[reliability] scheduled: ${cfg.reliabilityCron} (reflection=${cfg.reflectionEnabled})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

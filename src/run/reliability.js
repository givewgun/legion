import cron from 'node-cron';
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createGunvestClient } from '../data/gunvest.js';
import { resolveSignals } from '../reliability/resolver.js';
import { recomputeReliability } from '../reliability/update.js';
import { recomputeCorrelations } from '../reliability/correlations.js';

// One pass: resolve every due signal against forward/benchmark returns, recompute
// each agent's reliability ρ and calibration from its resolved forecasts, then
// recompute pairwise vote correlations for the quorum redundancy discount.
export async function runReliabilityOnce({ repo, gunvest, clock = () => new Date() }) {
  const now = clock().toISOString();
  const resolved = await resolveSignals(repo, gunvest, now);
  const reliability = await recomputeReliability(repo);
  const correlations = await recomputeCorrelations(repo);
  return { resolved, reliability, correlations: correlations.length };
}

function main() {
  const cfg = loadConfig();
  const repo = createRepo(connectDb(cfg.databaseUrl));
  const gunvest = createGunvestClient(cfg.gunvestApiUrl);
  const runner = () =>
    runReliabilityOnce({ repo, gunvest })
      .then((s) => console.log(`[reliability] resolved=${s.resolved}`, s.reliability))
      .catch((err) => console.error(`[reliability] run failed: ${err.message}`));

  if (process.argv.includes('--now')) {
    runner();
    return;
  }
  cron.schedule(cfg.reliabilityCron, runner);
  console.log(`[reliability] scheduled: ${cfg.reliabilityCron}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

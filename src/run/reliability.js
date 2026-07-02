import cron from 'node-cron';
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createGunvestFromConfig } from '../data/gunvest.js';
import { createProvider } from '../llm/provider.js';
import { runReliabilityOnce } from '../reliability/run-once.js';

// The learning pass itself lives in src/reliability/run-once.js (shared with the
// dashboard's on-demand relearn endpoint); re-exported here for existing callers.
export { runReliabilityOnce };

// Boot wiring: run one pass immediately so a fresh deploy (or restart) starts
// resolving already-due signals and learning right away instead of waiting up to
// a full cron interval, then arm the recurring schedule.
//
// The boot pass uses `bootRunner` (resolve + recompute only — pure DB work that
// is deterministic and idempotent, so it is safe to repeat on every deploy). The
// scheduled `runner` additionally runs LLM reflection; we keep that off the boot
// path so frequent deploys don't re-spend Ollama on each restart or contend with
// the agents for the single Ollama slot during market hours.
// `schedule`/`runImmediately` are injectable for tests.
export function startReliability({
  runner,
  bootRunner = runner,
  cronExpr,
  schedule = cron.schedule,
  runImmediately = true,
}) {
  if (runImmediately) bootRunner();
  return schedule(cronExpr, runner);
}

function main() {
  const cfg = loadConfig();
  const repo = createRepo(connectDb(cfg.databaseUrl));
  const gunvest = createGunvestFromConfig(cfg);
  const reflectionProvider = cfg.reflectionEnabled ? createProvider('local', cfg) : null;
  const makeRunner = (provider, tag) => () =>
    runReliabilityOnce({ repo, gunvest, reflectionProvider: provider })
      .then((s) =>
        console.log(
          `[reliability${tag}] resolved=${s.resolved} lessons=${s.lessons}`,
          s.reliability,
        ),
      )
      .catch((err) => console.error(`[reliability${tag}] run failed: ${err.message}`));
  const runner = makeRunner(reflectionProvider, '');
  // Boot pass never reflects, even when reflection is enabled.
  const bootRunner = makeRunner(null, ':boot');

  if (process.argv.includes('--now')) {
    runner();
    return;
  }
  startReliability({ runner, bootRunner, cronExpr: cfg.reliabilityCron });
  console.log(
    `[reliability] scheduled: ${cfg.reliabilityCron} (reflection=${cfg.reflectionEnabled}, resolve+recompute kicked once on boot)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();

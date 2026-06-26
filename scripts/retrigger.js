import 'dotenv/config';
import { loadConfig } from '../src/config/index.js';
import { connectBus } from '../src/bus/nats.js';
import { connectDb } from '../src/db/client.js';
import { createRepo } from '../src/db/repo.js';
import { createOrchestrator } from '../src/orchestrator.js';

// Operator script: cancel in-flight evaluation cycles and re-kick a fresh sweep.
// Use after a bad run (e.g. the panel stalled on a slow model) to clear the
// running cycles and start clean instead of waiting for the next scheduled sweep.
//
//   node scripts/retrigger.js                 # cancel all running + re-kick every enabled ticker
//   node scripts/retrigger.js --cancel-only   # only cancel; do not re-kick
//   node scripts/retrigger.js --trigger-only  # only re-kick; leave running cycles alone
//   node scripts/retrigger.js --symbol AAPL   # operate on one ticker (cancel is global)
//
// Cancelling marks every 'running' cycle 'timeout' and deletes its pending
// votes/constraints, mirroring the emitter's own stale-cycle cleanup so a
// later crash-recovery pass can't resurrect a cycle we deliberately abandoned.
async function main() {
  const args = new Set(process.argv.slice(2));
  const cancelOnly = args.has('--cancel-only');
  const triggerOnly = args.has('--trigger-only');
  const symbolArg = process.argv.find((a) => a.startsWith('--symbol='))?.split('=')[1];
  const symbol = symbolArg?.toUpperCase() ?? null;

  const cfg = loadConfig();
  const db = connectDb(cfg.databaseUrl);
  const repo = createRepo(db);
  const bus = await connectBus(cfg.natsUrl);
  const orchestrator = createOrchestrator({ bus, repo });

  try {
    if (!triggerOnly) {
      // cutoff = now, activeIds = [] → close every cycle still 'running'.
      const closed = await repo.timeoutStaleCycles(new Date(), []);
      for (const c of closed) await repo.deletePendingCycle(c.id);
      console.log(
        `[retrigger] cancelled ${closed.length} running cycle(s)` +
          (closed.length ? `: ${closed.map((c) => `${c.symbol}#${c.id}`).join(', ')}` : ''),
      );
    }

    if (!cancelOnly) {
      const symbols = symbol ? [symbol] : await repo.listEnabledTickers();
      const kicked = [];
      for (const s of symbols) kicked.push(`${s}#${await orchestrator.kick(s)}`);
      console.log(`[retrigger] kicked ${kicked.length} ticker(s): ${kicked.join(', ')}`);
    }
  } finally {
    await bus.close();
    await db.pool.end();
  }
}

main().catch((err) => {
  console.error(`[retrigger] failed: ${err.message}`);
  process.exitCode = 1;
});

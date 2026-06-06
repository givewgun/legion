import 'dotenv/config';
import cron from 'node-cron';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createOrchestrator } from '../orchestrator.js';
import { createScheduler } from '../scheduler.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const repo = createRepo(connectDb(cfg.databaseUrl));
const orchestrator = createOrchestrator({ bus, repo });
const scheduler = createScheduler({ orchestrator, repo });

const schedule = process.env.LEGION_CRON || '0 */4 * * *'; // every 4h
cron.schedule(schedule, () => {
  scheduler.runOnce().then((s) => console.log(`[scheduler] kicked ${s.length} tickers`));
});
console.log(`[scheduler] armed (${schedule})`);

if (process.argv.includes('--now')) {
  const s = await scheduler.runOnce();
  console.log(`[scheduler] immediate run kicked ${s.length} tickers`);
}

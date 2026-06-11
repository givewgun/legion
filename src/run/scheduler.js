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

// Two sweeps per US trading day, expressed in the exchange's timezone
// (cfg.cronTimezone, default America/New_York — NOT the container TZ): 11:00 ET
// mid-session catches overnight/pre-market news with live macro; 17:00 ET is an
// hour after the close, so the day's candle is final. Agents read DAILY candles,
// so extra fires re-evaluate the same bar (noise, not signal), and weekend fires
// can neither see new bars nor start resolving (ADR 0029).
const schedule = process.env.LEGION_CRON || '0 11,17 * * 1-5';
cron.schedule(
  schedule,
  () => {
    scheduler.runOnce().then((s) => console.log(`[scheduler] kicked ${s.length} tickers`));
  },
  { timezone: cfg.cronTimezone },
);
console.log(`[scheduler] armed (${schedule} ${cfg.cronTimezone})`);

if (process.argv.includes('--now')) {
  const s = await scheduler.runOnce();
  console.log(`[scheduler] immediate run kicked ${s.length} tickers`);
}

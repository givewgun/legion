import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createOrchestrator } from '../orchestrator.js';

const symbol = process.argv[2];
if (!symbol) {
  console.error('usage: node src/run/orchestrator.js <TICKER>');
  process.exit(1);
}

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const repo = createRepo(connectDb(cfg.databaseUrl));
const orch = createOrchestrator({ bus, repo });

const cycleId = await orch.kick(symbol);
console.log(`[orchestrator] kicked ${symbol.toUpperCase()} cycle ${cycleId}`);
setTimeout(() => process.exit(0), 500);

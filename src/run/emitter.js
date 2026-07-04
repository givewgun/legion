import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createGunvestFromConfig } from '../data/gunvest.js';
import { createEmitter } from '../emit/emitter.js';
import { createQualityService } from '../quality/index.js';
import { sendTelegram } from '../emit/telegram.js';
import { createBrokerFromConfig } from '../broker/broker.js';
import { createExecutor } from '../exec/executor.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const repo = createRepo(connectDb(cfg.databaseUrl));
const gunvest = createGunvestFromConfig(cfg);
const quality = gunvest ? createQualityService({ gunvest }) : null;

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const telegram = (text) => sendTelegram(token, chatId, text);

const expectedAgents = Number(process.env.LEGION_EXPECTED_AGENTS || '4');
const riskEnabled = process.env.LEGION_RISK_ENABLED !== 'false';

// start() resolves once pre-crash pending state has been replayed (ADR 0024).
await createEmitter({
  bus,
  repo,
  telegram,
  gunvest,
  quality,
  consensus: cfg.consensus,
  expectedAgents,
  riskEnabled,
  staleEntryMs: cfg.emitter.staleEntryMs,
}).start();
console.log(
  `[emitter] listening for votes (expectedAgents=${expectedAgents}, risk=${riskEnabled})`,
);

// IBKR paper-trading executor (ADR 0035): drains the order-intent outbox this
// emitter writes. Unconfigured gateway or no gunvest → executor stays off and
// intents accumulate as pending (visible on the dashboard order log).
const broker = createBrokerFromConfig(cfg);
if (broker && gunvest) {
  createExecutor({ repo, broker, gunvest, cfg }).start();
  console.log('[emitter] order executor started');
} else {
  console.log('[emitter] order executor disabled (no IBKR_GATEWAY_URL or gunvest)');
}

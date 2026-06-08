import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createGunvestClient } from '../data/gunvest.js';
import { createEmitter } from '../emit/emitter.js';
import { sendTelegram } from '../emit/telegram.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const repo = createRepo(connectDb(cfg.databaseUrl));
const gunvest = createGunvestClient(cfg.gunvestApiUrl);

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const telegram = (text) => sendTelegram(token, chatId, text);

const expectedAgents = Number(process.env.LEGION_EXPECTED_AGENTS || '4');
const riskEnabled = process.env.LEGION_RISK_ENABLED !== 'false';

createEmitter({
  bus,
  repo,
  telegram,
  gunvest,
  consensus: cfg.consensus,
  expectedAgents,
  riskEnabled,
}).start();
console.log(
  `[emitter] listening for votes (expectedAgents=${expectedAgents}, risk=${riskEnabled})`,
);

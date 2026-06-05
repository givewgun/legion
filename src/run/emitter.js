import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createEmitter } from '../emit/emitter.js';
import { sendTelegram } from '../emit/telegram.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const repo = createRepo(connectDb(cfg.databaseUrl));

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const telegram = (text) => sendTelegram(token, chatId, text);

const expectedAgents = Number(process.env.LEGION_EXPECTED_AGENTS || '1');

createEmitter({ bus, repo, telegram, consensus: cfg.consensus, expectedAgents }).start();
console.log(`[emitter] listening for votes (expectedAgents=${expectedAgents})`);

import cron from 'node-cron';
import 'dotenv/config';
import { buildSummary } from '../summary/build.js';
import { loadConfig } from '../config/index.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { sendTelegram } from '../emit/telegram.js';

// One pass: pull the last `windowHours` of signals, build the digest, send it.
// `telegram` is a function (text) => Promise, matching the emitter's wiring.
export async function runSummaryOnce({
  repo,
  telegram,
  clock = () => new Date(),
  windowHours = 6,
}) {
  const until = clock();
  const since = new Date(until.getTime() - windowHours * 3600000);
  const signals = await repo.listSignalsSince(since.toISOString());
  const text = buildSummary(signals, {
    since: since.toISOString(),
    until: until.toISOString(),
  });
  await telegram(text);
  return { sent: true, count: signals.length };
}

function main() {
  const cfg = loadConfig();
  const repo = createRepo(connectDb(cfg.databaseUrl));
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const telegram = (text) => sendTelegram(token, chatId, text);
  const runner = () =>
    runSummaryOnce({ repo, telegram, windowHours: cfg.summaryWindowHours })
      .then((s) => console.log(`[summary] sent: ${s.count} signals`))
      .catch((err) => console.error(`[summary] run failed: ${err.message}`));

  if (process.argv.includes('--now')) {
    runner();
    return;
  }
  cron.schedule(cfg.summaryCron, runner);
  console.log(`[summary] scheduled: ${cfg.summaryCron}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

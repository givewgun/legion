import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createGunvestClient } from '../data/gunvest.js';
import { runBacktest } from '../backtest/deterministic.js';

const FETCH_DAYS = 400; // ~18 months of candles, enough for sma50 + a horizon walk

// For each enabled ticker, replay the deterministic quant strategy over its
// candle history and record hit-rate + P&L vs SPY/QQQ.
export async function runBacktestOnce({ repo, gunvest, horizonDays }) {
  const tickers = await repo.listEnabledTickers();
  const [spy, qqq] = await Promise.all([
    gunvest.getCandles('SPY', FETCH_DAYS),
    gunvest.getCandles('QQQ', FETCH_DAYS),
  ]);
  for (const symbol of tickers) {
    const candles = await gunvest.getCandles(symbol, FETCH_DAYS);
    const r = runBacktest(candles, spy, qqq, { horizon: horizonDays });
    await repo.recordBacktestResult({ symbol, horizon: horizonDays, ...r });
  }
  return { tickers: tickers.length };
}

async function main() {
  const cfg = loadConfig();
  const db = connectDb(cfg.databaseUrl);
  const repo = createRepo(db);
  const gunvest = createGunvestClient(cfg.gunvestApiUrl);
  try {
    const s = await runBacktestOnce({ repo, gunvest, horizonDays: cfg.horizonDays });
    console.log(`[backtest] complete: ${s.tickers} tickers`);
  } catch (err) {
    console.error(`[backtest] failed: ${err.message}`);
  } finally {
    await db.pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

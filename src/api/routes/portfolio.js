import { Router } from 'express';
import { simulatePortfolio } from '../../portfolio/simulate.js';

// Same candle depth as run/backtest.js — enough history to cover every signal.
const FetchDays = 400;
// Signals change at most once per cycle; candle fetches are the slow part.
const CacheTtlMs = 10 * 60 * 1000;

export function portfolioRoutes(repo, gunvest, { horizonDays = 5 } = {}) {
  const router = Router();
  let cache = null; // { at, payload }

  // `_req` (not `req`): the handler takes no query params and ESLint errors on
  // unused args unless they are underscore-prefixed.
  router.get('/', async (_req, res, next) => {
    try {
      if (!gunvest) return res.status(503).json({ error: 'price data unavailable' });
      if (cache && Date.now() - cache.at < CacheTtlMs) return res.json(cache.payload);

      const signals = await repo.listAllSignals();
      const symbols = [...new Set(signals.map((s) => s.symbol))];
      // Benchmark failures fail the whole request; a single symbol's failure
      // only skips that symbol's trades (the sim counts them as skipped).
      const [spy, qqq] = await Promise.all([
        gunvest.getCandles('SPY', FetchDays),
        gunvest.getCandles('QQQ', FetchDays),
      ]);
      const candlesBySymbol = {};
      await Promise.all(
        symbols.map(async (symbol) => {
          try {
            candlesBySymbol[symbol] = await gunvest.getCandles(symbol, FetchDays);
          } catch (err) {
            console.warn(`[portfolio] candles for ${symbol} unavailable: ${err.message}`);
            candlesBySymbol[symbol] = [];
          }
        }),
      );

      const payload = simulatePortfolio(signals, candlesBySymbol, spy, qqq, { horizonDays });
      cache = { at: Date.now(), payload };
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

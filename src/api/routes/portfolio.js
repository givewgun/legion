import { Router } from 'express';
import { simulatePortfolio } from '../../portfolio/simulate.js';

// Same candle depth as run/backtest.js — enough history to cover every signal.
const FetchDays = 400;
// Signals change at most once per cycle; candle fetches are the slow part.
const CacheTtlMs = 10 * 60 * 1000;
// Default sim config for a user who hasn't customized theirs.
const DefaultStartingCash = 100000;

// Per-user simulated portfolio: replays the shared signals filtered to the
// user's watchlist, with their starting cash + horizon. Deterministic — no
// stored positions. Cached per user (keyed by userId + a watchlist/config
// signature) so a config change busts only that user's entry.
export function portfolioRoutes(repo, gunvest, { horizonDays = 5 } = {}) {
  const router = Router();
  const cache = new Map(); // userId -> { at, key, payload }

  router.get('/', async (req, res, next) => {
    try {
      if (!gunvest) return res.status(503).json({ error: 'price data unavailable' });
      const userId = req.user.id;

      const [watchlist, config] = await Promise.all([
        repo.listWatchlist(userId),
        repo.getPortfolioConfig(userId),
      ]);
      const startingCash = config?.startingCash ?? DefaultStartingCash;
      const userHorizon = config?.horizonDays ?? horizonDays;
      const key = JSON.stringify({ w: watchlist, c: startingCash, h: userHorizon });

      const hit = cache.get(userId);
      if (hit && hit.key === key && Date.now() - hit.at < CacheTtlMs) {
        return res.json(hit.payload);
      }

      const watchSet = new Set(watchlist);
      const signals = (await repo.listAllSignals()).filter((s) => watchSet.has(s.symbol));
      const symbols = [...new Set(signals.map((s) => s.symbol))];

      // Benchmark failure propagates and fails the request; per-symbol failure is caught and skipped.
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

      const payload = simulatePortfolio(signals, candlesBySymbol, spy, qqq, {
        horizonDays: userHorizon,
        startingCapital: startingCash,
      });
      cache.set(userId, { at: Date.now(), key, payload });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

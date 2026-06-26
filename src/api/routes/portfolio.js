import { Router } from 'express';
import { buildPaperBook } from '../../portfolio/paper-book.js';

const DefaultStartingCash = 100000;
const BaseWeight = 0.05;
const MaxPerName = 0.10;
// Live marks refresh ~ client poll cadence.
const CacheTtlMs = 30 * 1000;

// Per-user live paper book: builds open positions from emitted signals filtered
// to the user's watchlist, sized by conviction × qualityMult, marked to live
// prices from gunvest. Cached per user (keyed by watchlist/config signature)
// so a config change busts only that user's entry.
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
      const startingCapital = config?.startingCash ?? DefaultStartingCash;
      const userHorizon = config?.horizonDays ?? horizonDays;

      const watchSet = new Set(watchlist);
      const signals = (await repo.listAllSignals()).filter((s) => watchSet.has(s.symbol));

      // `n: signals.length` busts the cache the instant a new signal is emitted.
      // Safe because legion.signals is append-only (count strictly increases); if a
      // signal-deletion feature is ever added, switch this to a max-id/updated-at.
      const key = JSON.stringify({ w: watchlist, c: startingCapital, h: userHorizon, n: signals.length });
      const hit = cache.get(userId);
      if (hit && hit.key === key && Date.now() - hit.at < CacheTtlMs) return res.json(hit.payload);
      const symbols = [...new Set(signals.map((s) => s.symbol))];

      const livePrices = {};
      await Promise.all([...symbols, 'SPY', 'QQQ'].map(async (sym) => {
        const p = await gunvest.getPrice(sym).catch(() => null);
        if (p?.price != null) livePrices[sym] = p.price;
      }));

      const payload = buildPaperBook(signals, livePrices, {
        startingCapital, horizonDays: userHorizon, baseWeight: BaseWeight, maxPerName: MaxPerName,
      });
      cache.set(userId, { at: Date.now(), key, payload });
      res.json(payload);
    } catch (err) { next(err); }
  });

  return router;
}

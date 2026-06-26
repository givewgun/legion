import { Router } from 'express';
import { buildSizingBook } from '../../sizing/engine.js';

// Per-user real-holdings book. CRUD over legion.holdings plus a /sizing endpoint
// that joins holdings + latest signals + live price + cached quality through the
// shared pure sizing engine. Suggest-only — never trades.
export function holdingsRoutes(repo, gunvest, quality) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json({ holdings: await repo.listHoldings(req.user.id) });
    } catch (err) { next(err); }
  });

  router.put('/:ticker', async (req, res, next) => {
    try {
      const { shares, avgCost, notes } = req.body ?? {};
      if (!(Number(shares) >= 0) || !(Number(avgCost) >= 0)) {
        return res.status(400).json({ error: 'shares and avgCost must be non-negative numbers' });
      }
      await repo.upsertHolding(req.user.id, { ticker: req.params.ticker, shares: Number(shares), avgCost: Number(avgCost), notes });
      res.status(201).json({ holdings: await repo.listHoldings(req.user.id) });
    } catch (err) { next(err); }
  });

  router.delete('/:ticker', async (req, res, next) => {
    try {
      await repo.deleteHolding(req.user.id, req.params.ticker);
      res.json({ holdings: await repo.listHoldings(req.user.id) });
    } catch (err) { next(err); }
  });

  router.get('/sizing', async (req, res, next) => {
    try {
      if (!gunvest) return res.status(503).json({ error: 'price data unavailable' });
      if (!quality) return res.status(503).json({ error: 'quality service unavailable' });
      const holdings = await repo.listHoldings(req.user.id);
      const symbols = [...new Set(holdings.map((h) => h.ticker))];

      // Latest signal per symbol (listAllSignals is oldest-first; last write wins).
      const signalsBySymbol = {};
      for (const s of await repo.listAllSignals()) {
        if (symbols.includes(s.symbol)) signalsBySymbol[s.symbol] = s;
      }

      const pricesBySymbol = {};
      const qualityBySymbol = {};
      await Promise.all(symbols.map(async (sym) => {
        const price = await gunvest.getPrice(sym).catch(() => null);
        pricesBySymbol[sym] = price ?? {};
        qualityBySymbol[sym] = await quality.getQuality(sym, price?.price).catch(() => ({ qualityMult: 1, flags: ['quality:error'] }));
      }));

      res.json(buildSizingBook({ holdings, signalsBySymbol, qualityBySymbol, pricesBySymbol, config: {} }));
    } catch (err) { next(err); }
  });

  return router;
}

import { Router } from 'express';

// Per-user watchlist over the global ticker roster. Every handler reads
// req.user (set by requireUser). Symbols are validated against legion.tickers
// so a user can only follow a ticker the engine actually evaluates.
export function watchlistRoutes(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json({ symbols: await repo.listWatchlist(req.user.id) });
    } catch (err) {
      next(err);
    }
  });

  router.put('/:symbol', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const roster = await repo.listTickers();
      if (!roster.some((t) => t.symbol === symbol)) {
        return res.status(404).json({ error: 'symbol not in roster' });
      }
      await repo.addWatchlistSymbol(req.user.id, req.params.symbol);
      res.status(201).json({ symbols: await repo.listWatchlist(req.user.id) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:symbol', async (req, res, next) => {
    try {
      await repo.removeWatchlistSymbol(req.user.id, req.params.symbol);
      res.json({ symbols: await repo.listWatchlist(req.user.id) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

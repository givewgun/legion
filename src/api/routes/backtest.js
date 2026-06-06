import { Router } from 'express';

const LIMIT = 50;

// Read-only deterministic-backtest results, optionally filtered by symbol.
export function backtestRoutes(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const symbol = req.query.symbol ? String(req.query.symbol) : null;
      res.json(await repo.listBacktestResults(symbol, LIMIT));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

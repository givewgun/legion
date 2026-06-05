import { Router } from 'express';

export function tickerRoutes(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json(await repo.listTickers());
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const { symbol } = req.body ?? {};
      if (!symbol || typeof symbol !== 'string') {
        return res.status(400).json({ error: 'symbol is required' });
      }
      res.status(201).json(await repo.upsertTicker(symbol));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:symbol', async (req, res, next) => {
    try {
      const { enabled } = req.body ?? {};
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      const row = await repo.setTickerEnabled(req.params.symbol, enabled);
      if (!row) return res.status(404).json({ error: 'ticker not found' });
      res.json(row);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

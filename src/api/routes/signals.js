import { Router } from 'express';

export function signalRoutes(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const symbol = req.query.symbol ? String(req.query.symbol) : null;
      res.json(await repo.listSignals(symbol, 50));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

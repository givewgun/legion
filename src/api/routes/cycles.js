import { Router } from 'express';
import { assembleDebate } from '../debate.js';

export function cycleRoutes(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const { symbol } = req.query;
      if (!symbol) return res.status(400).json({ error: 'symbol query param is required' });
      res.json(await repo.listCycles(String(symbol), 20));
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
      const debate = await assembleDebate(repo, id);
      if (!debate) return res.status(404).json({ error: 'cycle not found' });
      res.json(debate);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

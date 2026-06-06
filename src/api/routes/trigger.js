import { Router } from 'express';

// Force-trigger evaluation cycles on demand, so testing a change does not mean
// waiting for the next scheduled sweep. Requires an orchestrator (NATS bus); in
// data-only mode (no bus) the endpoints return 503.
export function triggerRoutes(orchestrator, repo) {
  const router = Router();

  const unavailable = (res) =>
    res.status(503).json({ error: 'trigger unavailable: NATS bus not connected' });

  // Sweep: kick every enabled ticker now (same as `scheduler --now`).
  router.post('/', async (req, res, next) => {
    if (!orchestrator) return unavailable(res);
    try {
      const symbols = await repo.listEnabledTickers();
      const kicked = [];
      for (const symbol of symbols) {
        kicked.push({ symbol, cycleId: await orchestrator.kick(symbol) });
      }
      res.status(202).json({ kicked });
    } catch (err) {
      next(err);
    }
  });

  // Kick a single ticker now.
  router.post('/:symbol', async (req, res, next) => {
    if (!orchestrator) return unavailable(res);
    try {
      const symbol = req.params.symbol.toUpperCase();
      const cycleId = await orchestrator.kick(symbol);
      res.status(202).json({ symbol, cycleId });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

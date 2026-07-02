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

  // Stop every in-flight cycle. Publish-only (202): the emitter owns cycle state,
  // so it drops the buffers and closes the DB rows as 'stopped'; the response
  // reports which running cycles the stop covers.
  router.delete('/', async (req, res, next) => {
    if (!orchestrator) return unavailable(res);
    try {
      const stopping = await repo.listRunningCycles();
      for (const symbol of new Set(stopping.map((c) => c.symbol))) {
        orchestrator.stop(symbol);
      }
      res.status(202).json({ stopping });
    } catch (err) {
      next(err);
    }
  });

  // Stop the in-flight cycles of a single ticker. Published even when nothing is
  // running (harmless no-op on the emitter) to cover a kick racing the query.
  router.delete('/:symbol', async (req, res, next) => {
    if (!orchestrator) return unavailable(res);
    try {
      const symbol = req.params.symbol.toUpperCase();
      const stopping = (await repo.listRunningCycles()).filter((c) => c.symbol === symbol);
      orchestrator.stop(symbol);
      res.status(202).json({ symbol, stopping });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

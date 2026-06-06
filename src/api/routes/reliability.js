import { Router } from 'express';

// Read-only reliability leaderboard (per-agent ρ_i ordered by rho desc).
export function reliabilityRoutes(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json(await repo.getReliabilityLeaderboard());
    } catch (err) {
      next(err);
    }
  });

  return router;
}

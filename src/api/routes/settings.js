import { Router } from 'express';

// Global runtime flags editable from the dashboard. Currently just the home-PC
// model kill switch (a manual override on top of the PC-side busy-check).
export function settingsRoutes(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json({ homePcEnabled: await repo.getHomePcEnabled() });
    } catch (err) {
      next(err);
    }
  });

  router.put('/', async (req, res, next) => {
    try {
      const { homePcEnabled } = req.body ?? {};
      if (typeof homePcEnabled !== 'boolean') {
        return res.status(400).json({ error: 'homePcEnabled must be a boolean' });
      }
      await repo.setHomePcEnabled(homePcEnabled);
      res.json({ homePcEnabled });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

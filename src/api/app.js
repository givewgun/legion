import express from 'express';
import { tickerRoutes } from './routes/tickers.js';
import { cycleRoutes } from './routes/cycles.js';
import { signalRoutes } from './routes/signals.js';
import { reliabilityRoutes } from './routes/reliability.js';
import { backtestRoutes } from './routes/backtest.js';
import { triggerRoutes } from './routes/trigger.js';
import { agentRoutes } from './routes/agents.js';
import { portfolioRoutes } from './routes/portfolio.js';
import { watchlistRoutes } from './routes/watchlist.js';
import { authRoutes } from '../auth/routes.js';
import { requireUser } from '../auth/middleware.js';
import { httpMetricsMiddleware } from '../instrumentation/metrics.js';

// Builds the Express app without listening (so tests can drive it in-process).
// When `auth` is supplied, the whole /api surface (except /api/auth and
// /health) is gated by requireUser; per-user routes (watchlist, portfolio) read
// req.user. Without `auth`, gating is skipped — used by route unit tests that
// exercise business logic directly.
export function createApp({ repo, orchestrator = null, gunvest = null, horizonDays = 5, auth = null }) {
  const app = express();
  app.use(express.json());
  app.use(httpMetricsMiddleware);

  app.get('/health', (req, res) => res.json({ ok: true }));

  if (auth) {
    app.use(auth.session);
    app.use('/api/auth', authRoutes(auth));
    // Gate everything else under /api.
    app.use('/api', requireUser(repo));
  }

  app.use('/api/tickers', tickerRoutes(repo));
  app.use('/api/cycles', cycleRoutes(repo));
  app.use('/api/signals', signalRoutes(repo));
  app.use('/api/reliability', reliabilityRoutes(repo));
  app.use('/api/backtest', backtestRoutes(repo));
  app.use('/api/trigger', triggerRoutes(orchestrator, repo));
  app.use('/api/agents', agentRoutes(repo));
  app.use('/api/watchlist', watchlistRoutes(repo));
  app.use('/api/portfolio', portfolioRoutes(repo, gunvest, { horizonDays }));

  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}

import express from 'express';
import { tickerRoutes } from './routes/tickers.js';
import { cycleRoutes } from './routes/cycles.js';
import { signalRoutes } from './routes/signals.js';
import { reliabilityRoutes } from './routes/reliability.js';
import { backtestRoutes } from './routes/backtest.js';
import { triggerRoutes } from './routes/trigger.js';
import { agentRoutes } from './routes/agents.js';
import { holdingsRoutes } from './routes/holdings.js';
import { portfolioRoutes } from './routes/portfolio.js';
import { simulatedPortfolioRoutes } from './routes/simulated-portfolio.js';
import { watchlistRoutes } from './routes/watchlist.js';
import { settingsRoutes } from './routes/settings.js';
import { brokerRoutes } from './routes/broker.js';
import { authRoutes } from '../auth/routes.js';
import { requireUser } from '../auth/middleware.js';
import { httpMetricsMiddleware } from '../instrumentation/metrics.js';

// Builds the Express app without listening (so tests can drive it in-process).
// When `auth` is supplied, the whole /api surface (except /api/auth and
// /health) is gated by requireUser; per-user routes (watchlist, holdings) read
// req.user. `/api/portfolio` is the one global (instance-level) book — it does
// not read req.user. Without `auth`, gating is skipped — used by route unit
// tests that exercise business logic directly.
export function createApp({
  repo,
  orchestrator = null,
  gunvest = null,
  auth = null,
  cfg = {},
  quality = null,
  brokers = null,
  brokerFactory = undefined,
}) {
  const app = express();
  app.use(express.json());
  app.use(httpMetricsMiddleware);

  app.get('/health', (req, res) => res.json({ ok: true }));

  if (auth) {
    // Behind nginx + the Cloudflare tunnel, the app sees plain HTTP while the
    // public connection is HTTPS. Trust the proxy so Express derives req.secure
    // from X-Forwarded-Proto — required for express-session to set the
    // Secure session cookie in production (else login silently loops).
    app.set('trust proxy', 1);
    app.use(auth.session);
    app.use('/api/auth', authRoutes(auth));
    // Gate everything else under /api.
    app.use('/api', requireUser(repo));
  }

  app.use('/api/tickers', tickerRoutes(repo));
  app.use('/api/cycles', cycleRoutes(repo));
  app.use('/api/signals', signalRoutes(repo));
  app.use('/api/reliability', reliabilityRoutes(repo, { gunvest }));
  app.use('/api/backtest', backtestRoutes(repo));
  app.use('/api/trigger', triggerRoutes(orchestrator, repo));
  app.use('/api/agents', agentRoutes(repo));
  app.use('/api/watchlist', watchlistRoutes(repo));
  app.use('/api/holdings', holdingsRoutes(repo, gunvest, quality));
  app.use('/api/portfolio', portfolioRoutes(repo, gunvest, brokers));
  // Per-user deterministic simulated book — replays the shared signals against
  // each user's watchlist + starting cash, no broker needed. Coexists with the
  // broker-backed /api/portfolio above.
  app.use('/api/simulated-portfolio', simulatedPortfolioRoutes(repo, gunvest, { horizonDays: cfg.horizonDays }));
  app.use('/api/settings', settingsRoutes(repo, cfg));
  app.use('/api/broker', brokerRoutes(repo, cfg, brokerFactory));

  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}

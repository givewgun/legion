import express from 'express';
import { tickerRoutes } from './routes/tickers.js';
import { cycleRoutes } from './routes/cycles.js';
import { signalRoutes } from './routes/signals.js';
import { reliabilityRoutes } from './routes/reliability.js';
import { backtestRoutes } from './routes/backtest.js';
import { triggerRoutes } from './routes/trigger.js';
import { agentRoutes } from './routes/agents.js';
import { portfolioRoutes } from './routes/portfolio.js';
import { httpMetricsMiddleware } from '../instrumentation/metrics.js';

// Builds the Express app without listening (so tests can drive it in-process).
// Routes are mounted from the supplied repo. An optional orchestrator enables
// the on-demand trigger endpoint; without it those routes return 503.
export function createApp({ repo, orchestrator = null, gunvest = null, horizonDays = 5 }) {
  const app = express();
  app.use(express.json());
  // RED metrics for every API request (recorded into the shared registry that
  // the :9100 /metrics server exposes). Skips /metrics itself.
  app.use(httpMetricsMiddleware);

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api/tickers', tickerRoutes(repo));
  app.use('/api/cycles', cycleRoutes(repo));
  app.use('/api/signals', signalRoutes(repo));
  app.use('/api/reliability', reliabilityRoutes(repo));
  app.use('/api/backtest', backtestRoutes(repo));
  app.use('/api/trigger', triggerRoutes(orchestrator, repo));
  app.use('/api/agents', agentRoutes(repo));
  app.use('/api/portfolio', portfolioRoutes(repo, gunvest, { horizonDays }));

  // JSON error handler — never leak a stack to the client.
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}

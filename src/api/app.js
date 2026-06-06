import express from 'express';
import { tickerRoutes } from './routes/tickers.js';
import { cycleRoutes } from './routes/cycles.js';
import { signalRoutes } from './routes/signals.js';
import { reliabilityRoutes } from './routes/reliability.js';
import { backtestRoutes } from './routes/backtest.js';

// Builds the Express app without listening (so tests can drive it in-process).
// Routes are mounted from the supplied repo; no other state.
export function createApp({ repo }) {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api/tickers', tickerRoutes(repo));
  app.use('/api/cycles', cycleRoutes(repo));
  app.use('/api/signals', signalRoutes(repo));
  app.use('/api/reliability', reliabilityRoutes(repo));
  app.use('/api/backtest', backtestRoutes(repo));

  // JSON error handler — never leak a stack to the client.
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}

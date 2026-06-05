import express from 'express';
import { tickerRoutes } from './routes/tickers.js';

// Builds the Express app without listening (so tests can drive it in-process).
// Routes are mounted from the supplied repo; no other state.
export function createApp({ repo }) {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api/tickers', tickerRoutes(repo));

  // JSON error handler — never leak a stack to the client.
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}

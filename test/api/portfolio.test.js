import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { portfolioRoutes } from '../../src/api/routes/portfolio.js';

function build(repo, gunvest) {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use('/api/portfolio', portfolioRoutes(repo, gunvest, { horizonDays: 5 }));
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

const candles = [{ date: '2026-01-01', close: 100 }, { date: '2026-01-10', close: 110 }];

function repoStub(overrides = {}) {
  return {
    listWatchlist: vi.fn(async () => ['NVDA']),
    getPortfolioConfig: vi.fn(async () => ({ startingCash: 100000, horizonDays: 5 })),
    listAllSignals: vi.fn(async () => [
      { id: 1, symbol: 'NVDA', band: 'BUY', conviction: 0.7, plan: {}, created_at: '2026-01-01' },
      { id: 2, symbol: 'TSLA', band: 'BUY', conviction: 0.7, plan: {}, created_at: '2026-01-01' },
    ]),
    ...overrides,
  };
}

const gunvestStub = { getCandles: vi.fn(async () => candles) };

describe('per-user portfolio', () => {
  beforeEach(() => { gunvestStub.getCandles.mockClear(); });

  it('503s when price data is unavailable', async () => {
    const res = await request(build(repoStub(), null)).get('/api/portfolio');
    expect(res.status).toBe(503);
  });

  it('simulates only the user watchlist symbols', async () => {
    const repo = repoStub();
    const res = await request(build(repo, gunvestStub)).get('/api/portfolio');
    expect(res.status).toBe(200);
    // TSLA is filtered out (not on the watchlist); candles fetched for NVDA + benchmarks only.
    const fetched = gunvestStub.getCandles.mock.calls.map((c) => c[0]);
    expect(fetched).toContain('NVDA');
    expect(fetched).not.toContain('TSLA');
  });

  it('falls back to the default config when the user has none', async () => {
    const repo = repoStub({ getPortfolioConfig: vi.fn(async () => null) });
    const res = await request(build(repo, gunvestStub)).get('/api/portfolio');
    expect(res.status).toBe(200);
  });

  it('serves cached response on second request', async () => {
    const repo = repoStub();
    const app = build(repo, gunvestStub);
    await request(app).get('/api/portfolio');
    await request(app).get('/api/portfolio');
    expect(repo.listAllSignals).toHaveBeenCalledTimes(1);
  });

  it('skips a symbol whose candle fetch fails', async () => {
    const failing = { getCandles: vi.fn(async (sym) => {
      if (sym === 'NVDA') throw new Error('boom');
      return candles;
    })};
    const res = await request(build(repoStub(), failing)).get('/api/portfolio');
    expect(res.status).toBe(200);
  });

  it('fails the request when a benchmark fetch fails', async () => {
    const failing = { getCandles: vi.fn(async (sym) => {
      if (sym === 'SPY') throw new Error('down');
      return candles;
    })};
    const res = await request(build(repoStub(), failing)).get('/api/portfolio');
    expect(res.status).toBe(500);
  });
});

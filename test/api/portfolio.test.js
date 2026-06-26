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

// Signals with entry_price and plan.qualityMult for the paper book.
// NVDA: open BUY, entry 50, resolve_after far future.
// TSLA: filtered out (not on watchlist).
const farFuture = new Date(Date.now() + 365 * 86400000).toISOString();

function repoStub(overrides = {}) {
  return {
    listWatchlist: vi.fn(async () => ['NVDA']),
    getPortfolioConfig: vi.fn(async () => ({ startingCash: 100000, horizonDays: 5 })),
    listAllSignals: vi.fn(async () => [
      {
        id: 1, symbol: 'NVDA', band: 'BUY', conviction: 0.7,
        plan: { qualityMult: 1.2 }, created_at: '2026-01-01T10:00:00Z',
        entry_price: 50, spy_entry_price: 500, qqq_entry_price: 400,
        resolve_after: farFuture,
      },
      {
        id: 2, symbol: 'TSLA', band: 'BUY', conviction: 0.7,
        plan: { qualityMult: 1.0 }, created_at: '2026-01-01T10:00:00Z',
        entry_price: 200, spy_entry_price: 500, qqq_entry_price: 400,
        resolve_after: farFuture,
      },
    ]),
    ...overrides,
  };
}

const gunvestStub = {
  getPrice: vi.fn(async (sym) => {
    const prices = { NVDA: 75, SPY: 510, QQQ: 420 };
    return { price: prices[sym] ?? 100 };
  }),
};

describe('per-user portfolio', () => {
  beforeEach(() => { gunvestStub.getPrice.mockClear(); });

  it('503s when price data is unavailable', async () => {
    const res = await request(build(repoStub(), null)).get('/api/portfolio');
    expect(res.status).toBe(503);
  });

  it('returns openPositions and stats for watchlist symbols only', async () => {
    const repo = repoStub();
    const res = await request(build(repo, gunvestStub)).get('/api/portfolio');
    expect(res.status).toBe(200);
    // NVDA is in watchlist → open position marked at live price 75
    expect(res.body.openPositions[0].symbol).toBe('NVDA');
    expect(res.body.openPositions[0].markPrice).toBe(75);
    expect(res.body.stats.totalReturn).toBeGreaterThan(0);
  });

  it('TSLA is filtered out (not on watchlist)', async () => {
    const res = await request(build(repoStub(), gunvestStub)).get('/api/portfolio');
    expect(res.status).toBe(200);
    const symbols = res.body.openPositions.map((p) => p.symbol);
    expect(symbols).not.toContain('TSLA');
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

  it('returns 200 when a symbol price fetch fails (getPrice throws)', async () => {
    const failing = {
      getPrice: vi.fn(async (sym) => {
        if (sym === 'NVDA') throw new Error('boom');
        return { price: 100 };
      }),
    };
    const res = await request(build(repoStub(), failing)).get('/api/portfolio');
    expect(res.status).toBe(200);
  });
});

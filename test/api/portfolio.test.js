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
// NVDA: open BUY, entry 50, resolve_after far future. TSLA: filtered (not watchlisted).
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

// 3-day calendar: SPY 100→120 (+20%), QQQ flat, NVDA 50→60 (position gains).
const candles = {
  SPY: [{ date: '2026-01-01', close: 100 }, { date: '2026-01-02', close: 110 }, { date: '2026-01-03', close: 120 }],
  QQQ: [{ date: '2026-01-01', close: 100 }, { date: '2026-01-02', close: 100 }, { date: '2026-01-03', close: 100 }],
  NVDA: [{ date: '2026-01-01', close: 50 }, { date: '2026-01-02', close: 55 }, { date: '2026-01-03', close: 60 }],
};

const gunvestStub = {
  getCandles: vi.fn(async (sym) => candles[sym] ?? []),
  getPrice: vi.fn(async (sym) => ({ price: { NVDA: 75, SPY: 120, QQQ: 100 }[sym] ?? 100 })),
};

describe('per-user portfolio', () => {
  beforeEach(() => { gunvestStub.getPrice.mockClear(); gunvestStub.getCandles.mockClear(); });

  it('503s when price data is unavailable', async () => {
    const res = await request(build(repoStub(), null)).get('/api/portfolio');
    expect(res.status).toBe(503);
  });

  it('returns a curve, openPositions, and benchmark stats for watchlist symbols only', async () => {
    const repo = repoStub();
    const res = await request(build(repo, gunvestStub)).get('/api/portfolio');
    expect(res.status).toBe(200);
    // Daily equity curve with SPY/QQQ series.
    expect(res.body.curve.length).toBeGreaterThan(1);
    expect(res.body.curve[0]).toHaveProperty('spy');
    expect(res.body.curve[0]).toHaveProperty('qqq');
    // NVDA open position marked at the live price 75.
    expect(res.body.openPositions[0].symbol).toBe('NVDA');
    expect(res.body.openPositions[0].markPrice).toBe(75);
    // NVDA rose 50→60 on the curve → positive total return.
    expect(res.body.stats.totalReturn).toBeGreaterThan(0);
    // Benchmarks from candles: SPY 100→120 = +20%, QQQ flat = 0.
    expect(res.body.stats.spyReturn).toBeCloseTo(0.2, 5);
    expect(res.body.stats.qqqReturn).toBeCloseTo(0, 5);
  });

  it('TSLA is filtered out (not on watchlist)', async () => {
    const res = await request(build(repoStub(), gunvestStub)).get('/api/portfolio');
    expect(res.status).toBe(200);
    expect(res.body.openPositions.map((p) => p.symbol)).not.toContain('TSLA');
  });

  it('falls back to the default config when the user has none', async () => {
    const repo = repoStub({ getPortfolioConfig: vi.fn(async () => null) });
    const res = await request(build(repo, gunvestStub)).get('/api/portfolio');
    expect(res.status).toBe(200);
  });

  it('serves cached response on second request (skips candle/price fetch but re-reads signals)', async () => {
    const repo = repoStub();
    const app = build(repo, gunvestStub);
    await request(app).get('/api/portfolio');
    gunvestStub.getPrice.mockClear();
    gunvestStub.getCandles.mockClear();
    await request(app).get('/api/portfolio');
    // Signals DB read happens every request (freshness); candle/price fetches are cached.
    expect(repo.listAllSignals).toHaveBeenCalledTimes(2);
    expect(gunvestStub.getCandles).not.toHaveBeenCalled();
    expect(gunvestStub.getPrice).not.toHaveBeenCalled();
  });

  it('returns 200 when a symbol price fetch fails (getPrice throws)', async () => {
    const failing = {
      getCandles: vi.fn(async (sym) => candles[sym] ?? []),
      getPrice: vi.fn(async (sym) => {
        if (sym === 'NVDA') throw new Error('boom');
        return { price: 100 };
      }),
    };
    const res = await request(build(repoStub(), failing)).get('/api/portfolio');
    expect(res.status).toBe(200);
  });
});

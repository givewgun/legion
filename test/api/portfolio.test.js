import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { portfolioRoutes } from '../../src/api/routes/portfolio.js';

function build(repo, gunvest, broker) {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use('/api/portfolio', portfolioRoutes(repo, gunvest, broker));
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

// Two snapshots on 2026-07-01 (14:00 and 20:00 UTC) — bucketing keeps the LAST
// one per calendar day — plus one on 2026-07-02.
function repoStub(overrides = {}) {
  return {
    listEquitySnapshots: vi.fn(async () => [
      { ts: '2026-07-01T14:00:00Z', equity: 100000, cash: 50000 },
      { ts: '2026-07-01T20:00:00Z', equity: 100200, cash: 49800 },
      { ts: '2026-07-02T14:00:00Z', equity: 100400, cash: 49600 },
    ]),
    listOrderIntents: vi.fn(async () => [
      {
        id: 2, signalId: 20, symbol: 'MSFT', band: 'BUY', conviction: 0.6, qualityMult: 1,
        targetWeight: 0.03, status: 'pending', skipReason: null, brokerOrderId: null,
        submittedQty: null, fillQty: null, fillPrice: null, error: null, createdAt: '2026-07-02T10:00:00Z',
      },
      {
        id: 1, signalId: 10, symbol: 'AAPL', band: 'BUY', conviction: 0.8, qualityMult: 1.1,
        targetWeight: 0.048, status: 'filled', skipReason: null, brokerOrderId: 'B-1',
        submittedQty: 25, fillQty: 25, fillPrice: 190.1, error: null, createdAt: '2026-07-01T09:00:00Z',
      },
    ]),
    ...overrides,
  };
}

const candles = {
  SPY: [{ date: '2026-07-01', close: 500 }, { date: '2026-07-02', close: 505 }],
  QQQ: [{ date: '2026-07-01', close: 400 }, { date: '2026-07-02', close: 404 }],
};

function gunvestStub(overrides = {}) {
  return {
    getCandles: vi.fn(async (sym) => candles[sym] ?? []),
    getPrice: vi.fn(async (sym) => ({ price: { AAPL: 195.2 }[sym] ?? 100 })),
    ...overrides,
  };
}

function brokerStub(overrides = {}) {
  return {
    isAuthenticated: vi.fn(async () => true),
    getPositions: vi.fn(async () => [{ symbol: 'AAPL', qty: 25, avgCost: 190.1, conid: 1 }]),
    getAccountSummary: vi.fn(async () => ({ accountId: 'DU123456', equity: 100500, cash: 40000 })),
    ...overrides,
  };
}

describe('/api/portfolio (IBKR-backed book)', () => {
  it('returns the full payload shape when the gateway is configured and authenticated', async () => {
    const res = await request(build(repoStub(), gunvestStub(), brokerStub())).get('/api/portfolio');
    expect(res.status).toBe(200);

    expect(res.body.gateway).toEqual({ configured: true, authenticated: true, accountId: 'DU123456' });

    // Curve bucketed to one point per calendar day (2 days, not 3 snapshots).
    expect(res.body.curve).toHaveLength(2);
    expect(res.body.curve[0]).toMatchObject({ date: '2026-07-01', equity: 100200 });
    expect(res.body.curve[1]).toMatchObject({ date: '2026-07-02', equity: 100400 });
    // Benchmarks normalized to the first bucketed point's equity.
    expect(res.body.curve[0].spy).toBeCloseTo(100200, 5);
    expect(res.body.curve[1].spy).toBeCloseTo((100200 * 505) / 500, 5);
    expect(res.body.curve[0].qqq).toBeCloseTo(100200, 5);
    expect(res.body.curve[1].qqq).toBeCloseTo((100200 * 404) / 400, 5);

    // Stats: equity/cash from the live broker account; returns from the curve.
    expect(res.body.stats.equity).toBe(100500);
    expect(res.body.stats.cash).toBe(40000);
    expect(res.body.stats.totalReturn).toBeCloseTo(100400 / 100200 - 1, 6);
    expect(res.body.stats.spyReturn).toBeCloseTo(505 / 500 - 1, 6);
    expect(res.body.stats.qqqReturn).toBeCloseTo(404 / 400 - 1, 6);

    // Positions marked via gunvest.getPrice.
    expect(res.body.positions).toEqual([{
      symbol: 'AAPL', qty: 25, avgCost: 190.1, markPrice: 195.2,
      marketValue: 25 * 195.2, unrealizedPnl: (195.2 - 190.1) * 25,
      unrealizedPnlPct: (195.2 - 190.1) / 190.1,
    }]);

    // Orders newest-first from repo.listOrderIntents, mapped to the API shape.
    expect(res.body.orders).toEqual([
      {
        id: 2, createdAt: '2026-07-02T10:00:00Z', symbol: 'MSFT', band: 'BUY', conviction: 0.6,
        targetWeight: 0.03, status: 'pending', skipReason: null, submittedQty: null,
        fillQty: null, fillPrice: null, error: null,
      },
      {
        id: 1, createdAt: '2026-07-01T09:00:00Z', symbol: 'AAPL', band: 'BUY', conviction: 0.8,
        targetWeight: 0.048, status: 'filled', skipReason: null, submittedQty: 25,
        fillQty: 25, fillPrice: 190.1, error: null,
      },
    ]);
  });

  it('degrades gracefully when no broker is configured (broker === null)', async () => {
    const res = await request(build(repoStub(), gunvestStub(), null)).get('/api/portfolio');
    expect(res.status).toBe(200);
    expect(res.body.gateway).toEqual({ configured: false, authenticated: false, accountId: null });
    expect(res.body.positions).toEqual([]);
    expect(res.body.stats).toEqual({ equity: null, cash: null, totalReturn: null, spyReturn: null, qqqReturn: null });
    // History keeps serving even with no gateway.
    expect(res.body.curve).toHaveLength(2);
    expect(res.body.orders).toHaveLength(2);
  });

  it('degrades gracefully when the broker is configured but not authenticated', async () => {
    const broker = brokerStub({ isAuthenticated: vi.fn(async () => false) });
    const res = await request(build(repoStub(), gunvestStub(), broker)).get('/api/portfolio');
    expect(res.status).toBe(200);
    expect(res.body.gateway).toEqual({ configured: true, authenticated: false, accountId: null });
    expect(res.body.positions).toEqual([]);
    expect(res.body.stats).toEqual({ equity: null, cash: null, totalReturn: null, spyReturn: null, qqqReturn: null });
    expect(broker.getPositions).not.toHaveBeenCalled();
    expect(broker.getAccountSummary).not.toHaveBeenCalled();
    expect(res.body.curve).toHaveLength(2);
    expect(res.body.orders).toHaveLength(2);
  });

  it('still serves curve and orders when a broker read throws after auth succeeds', async () => {
    const broker = brokerStub({ getAccountSummary: vi.fn(async () => { throw new Error('gateway blip'); }) });
    const res = await request(build(repoStub(), gunvestStub(), broker)).get('/api/portfolio');
    expect(res.status).toBe(200);
    expect(res.body.gateway.authenticated).toBe(false);
    expect(res.body.positions).toEqual([]);
    expect(res.body.curve).toHaveLength(2);
    expect(res.body.orders).toHaveLength(2);
  });

  it('serves a cached response within the TTL, keyed by intent + snapshot counts', async () => {
    const repo = repoStub();
    const gunvest = gunvestStub();
    const broker = brokerStub();
    const app = build(repo, gunvest, broker);
    await request(app).get('/api/portfolio');
    broker.isAuthenticated.mockClear();
    broker.getPositions.mockClear();
    broker.getAccountSummary.mockClear();
    gunvest.getCandles.mockClear();
    gunvest.getPrice.mockClear();

    await request(app).get('/api/portfolio');
    // Freshness reads always happen (cheap, used for the cache key)...
    expect(repo.listEquitySnapshots).toHaveBeenCalledTimes(2);
    expect(repo.listOrderIntents).toHaveBeenCalledTimes(2);
    // ...but the expensive broker/gunvest work is skipped on a cache hit.
    expect(broker.isAuthenticated).not.toHaveBeenCalled();
    expect(broker.getPositions).not.toHaveBeenCalled();
    expect(broker.getAccountSummary).not.toHaveBeenCalled();
    expect(gunvest.getCandles).not.toHaveBeenCalled();
    expect(gunvest.getPrice).not.toHaveBeenCalled();
  });

  it('busts the cache when a new order intent appears', async () => {
    const intents = [
      { id: 1, signalId: 10, symbol: 'AAPL', band: 'BUY', conviction: 0.8, qualityMult: 1.1, targetWeight: 0.048, status: 'filled', skipReason: null, brokerOrderId: 'B-1', submittedQty: 25, fillQty: 25, fillPrice: 190.1, error: null, createdAt: '2026-07-01T09:00:00Z' },
    ];
    const repo = repoStub({ listOrderIntents: vi.fn(async () => intents) });
    const broker = brokerStub();
    const app = build(repo, gunvestStub(), broker);
    await request(app).get('/api/portfolio');
    broker.getAccountSummary.mockClear();

    intents.unshift({ id: 2, signalId: 20, symbol: 'MSFT', band: 'BUY', conviction: 0.6, qualityMult: 1, targetWeight: 0.03, status: 'pending', skipReason: null, brokerOrderId: null, submittedQty: null, fillQty: null, fillPrice: null, error: null, createdAt: '2026-07-02T10:00:00Z' });
    const res = await request(app).get('/api/portfolio');
    expect(res.body.orders).toHaveLength(2);
    expect(broker.getAccountSummary).toHaveBeenCalledTimes(1);
  });
});

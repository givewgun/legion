import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub(overrides = {}) {
  return {
    listTickers: vi.fn(async () => [{ symbol: 'NVDA', enabled: true }]),
    upsertTicker: vi.fn(async (s) => ({ symbol: s.toUpperCase(), enabled: true })),
    setTickerEnabled: vi.fn(async (s, e) => ({ symbol: s.toUpperCase(), enabled: e })),
    ...overrides,
  };
}

describe('ticker routes', () => {
  it('GET /api/tickers returns the list', async () => {
    const app = createApp({ repo: repoStub() });
    const res = await request(app).get('/api/tickers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ symbol: 'NVDA', enabled: true }]);
  });

  it('POST /api/tickers adds a ticker', async () => {
    const repo = repoStub();
    const app = createApp({ repo });
    const res = await request(app).post('/api/tickers').send({ symbol: 'amd' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ symbol: 'AMD', enabled: true });
    expect(repo.upsertTicker).toHaveBeenCalledWith('amd');
  });

  it('POST /api/tickers rejects a missing symbol', async () => {
    const app = createApp({ repo: repoStub() });
    const res = await request(app).post('/api/tickers').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/symbol/i);
  });

  it('PATCH /api/tickers/:symbol toggles enabled', async () => {
    const repo = repoStub();
    const app = createApp({ repo });
    const res = await request(app).patch('/api/tickers/NVDA').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ symbol: 'NVDA', enabled: false });
    expect(repo.setTickerEnabled).toHaveBeenCalledWith('NVDA', false);
  });

  it('PATCH rejects a non-boolean enabled', async () => {
    const app = createApp({ repo: repoStub() });
    const res = await request(app).patch('/api/tickers/NVDA').send({ enabled: 'yes' });
    expect(res.status).toBe(400);
  });

  it('PATCH 404s an unknown ticker', async () => {
    const app = createApp({ repo: repoStub({ setTickerEnabled: vi.fn(async () => null) }) });
    const res = await request(app).patch('/api/tickers/ZZZZ').send({ enabled: true });
    expect(res.status).toBe(404);
  });
});

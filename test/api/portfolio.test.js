import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

const day = (n) => `2026-01-${String(n).padStart(2, '0')}`;
const flat = (price, n) =>
  Array.from({ length: n }, (_, i) => ({ date: day(i + 1), close: price }));

function fixtures() {
  const repo = {
    listAllSignals: vi.fn(async () => [
      {
        id: 1,
        symbol: 'NVDA',
        band: 'BUY',
        conviction: '1.0',
        plan: {},
        created_at: `${day(1)}T14:30:00Z`,
      },
    ]),
  };
  const gunvest = { getCandles: vi.fn(async () => flat(100, 9)) };
  return { repo, gunvest };
}

describe('GET /api/portfolio', () => {
  it('replays signals into a portfolio payload', async () => {
    const { repo, gunvest } = fixtures();
    const res = await request(createApp({ repo, gunvest })).get('/api/portfolio');
    expect(res.status).toBe(200);
    expect(res.body.stats.trades).toBe(1);
    expect(res.body.curve).toHaveLength(9);
    expect(res.body.trades[0].symbol).toBe('NVDA');
  });

  it('caches the payload between requests', async () => {
    const { repo, gunvest } = fixtures();
    const app = createApp({ repo, gunvest });
    await request(app).get('/api/portfolio');
    await request(app).get('/api/portfolio');
    expect(repo.listAllSignals).toHaveBeenCalledTimes(1);
  });

  it('returns 503 without a gunvest client', async () => {
    const { repo } = fixtures();
    const res = await request(createApp({ repo })).get('/api/portfolio');
    expect(res.status).toBe(503);
  });

  it('skips a symbol whose candle fetch fails', async () => {
    const { repo, gunvest } = fixtures();
    gunvest.getCandles = vi.fn(async (symbol) => {
      if (symbol === 'NVDA') throw new Error('boom');
      return flat(100, 9);
    });
    const res = await request(createApp({ repo, gunvest })).get('/api/portfolio');
    expect(res.status).toBe(200);
    expect(res.body.stats.skipped).toBe(1);
    expect(res.body.stats.trades).toBe(0);
  });

  it('fails the request when a benchmark fetch fails', async () => {
    const { repo, gunvest } = fixtures();
    gunvest.getCandles = vi.fn(async (symbol) => {
      if (symbol === 'SPY') throw new Error('boom');
      return flat(100, 9);
    });
    const res = await request(createApp({ repo, gunvest })).get('/api/portfolio');
    expect(res.status).toBe(500);
  });
});

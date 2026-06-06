import { describe, it, expect, vi } from 'vitest';
import { createGunvestClient } from '../../src/data/gunvest.js';

function fetchReturning(payload) {
  return vi.fn(async () => ({ ok: true, json: async () => payload }));
}

describe('createGunvestClient', () => {
  it('fetches a ticker price from the market endpoint', async () => {
    const fetchMock = fetchReturning({ symbol: 'NVDA', price: 123.45 });
    const client = createGunvestClient('http://api:3001', fetchMock);
    const data = await client.getPrice('NVDA');
    expect(data).toEqual({ symbol: 'NVDA', price: 123.45 });
    expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/market/NVDA');
  });

  it('fetches ticker news', async () => {
    const fetchMock = fetchReturning([{ headline: 'x' }]);
    const client = createGunvestClient('http://api:3001', fetchMock);
    await client.getNews('MU');
    expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/news/MU');
  });

  it('fetches sentiment', async () => {
    const fetchMock = fetchReturning({ score: 0.2 });
    const client = createGunvestClient('http://api:3001', fetchMock);
    await client.getSentiment('NVDA');
    expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/sentiment/NVDA');
  });

  it('fetches macro overview', async () => {
    const fetchMock = fetchReturning({ risk: 'MODERATE' });
    const client = createGunvestClient('http://api:3001', fetchMock);
    await client.getMacro();
    expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/macro');
  });

  it('fetches the equity (stock) fear & greed index', async () => {
    const fetchMock = fetchReturning({ value: 72, label: 'Greed' });
    const client = createGunvestClient('http://api:3001', fetchMock);
    const data = await client.getStockFearGreed();
    expect(data).toEqual({ value: 72, label: 'Greed' });
    expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/sentiment/stock/fear-greed');
  });

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
    const client = createGunvestClient('http://api:3001', fetchMock);
    await expect(client.getPrice('ZZZ')).rejects.toThrow('GunVest API GET /api/market/ZZZ -> 404');
  });

  describe('getCandles', () => {
    it('requests the candles endpoint and maps date/close', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          candles: [
            { date: '2026-05-01', close: 100 },
            { date: '2026-05-02', close: 102 },
          ],
        }),
      }));
      const client = createGunvestClient('http://x', fetchMock);
      const out = await client.getCandles('NVDA', 30);
      expect(fetchMock).toHaveBeenCalledWith('http://x/api/market/NVDA/candles?days=30');
      expect(out).toEqual([
        { date: '2026-05-01', close: 100 },
        { date: '2026-05-02', close: 102 },
      ]);
    });

    it('throws on a non-ok candles response', async () => {
      const fetchMock = vi.fn(async () => ({ ok: false, status: 503 }));
      const client = createGunvestClient('http://x', fetchMock);
      await expect(client.getCandles('NVDA', 30)).rejects.toThrow(/503/);
    });
  });
});

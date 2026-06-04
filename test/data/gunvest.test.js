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

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
    const client = createGunvestClient('http://api:3001', fetchMock);
    await expect(client.getPrice('ZZZ')).rejects.toThrow('GunVest API GET /api/market/ZZZ -> 404');
  });
});

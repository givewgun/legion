import { describe, it, expect, vi } from 'vitest';
import { fetchPutCall } from '../../../src/data/feeds/cboe.js';

const ok = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => '',
});

// Realistic CNN graphdata fixture with two data points so "latest = last element" is exercised.
const CNN_FIXTURE = {
  put_call_options: {
    timestamp: 1780608300000,
    score: 96.6,
    rating: 'extreme greed',
    data: [
      { x: 1780444800000, y: 0.580363074086489, rating: 'extreme fear' },
      { x: 1780531200000, y: 0.586899207225797, rating: 'extreme fear' },
      { x: 1780608300000, y: 0.586899708854191, rating: 'extreme fear' },
    ],
  },
};

describe('fetchPutCall', () => {
  it('parses ratio, score, rating, and date from CNN graphdata', async () => {
    const fetchImpl = vi.fn(async () => ok(CNN_FIXTURE));
    const res = await fetchPutCall({ fetchImpl, url: 'http://x/graphdata' });
    // ratio = last data[].y
    expect(res.ratio).toBeCloseTo(0.586899708854191);
    // score and rating from top-level put_call_options
    expect(res.score).toBe(96.6);
    expect(res.rating).toBe('extreme greed');
    // date = YYYY-MM-DD from last data[].x (1780608300000 ms)
    expect(res.date).toBe(new Date(1780608300000).toISOString().slice(0, 10));
  });

  it('uses the latest (last) data element, not the first', async () => {
    const fixture = {
      put_call_options: {
        score: 50,
        rating: 'neutral',
        data: [
          { x: 1780444800000, y: 0.99, rating: 'fear' },
          { x: 1780531200000, y: 0.42, rating: 'greed' },
        ],
      },
    };
    const fetchImpl = vi.fn(async () => ok(fixture));
    const res = await fetchPutCall({ fetchImpl, url: 'http://x/graphdata' });
    expect(res.ratio).toBeCloseTo(0.42);
    expect(res.date).toBe(new Date(1780531200000).toISOString().slice(0, 10));
  });

  it('returns null when put_call_options is missing', async () => {
    const fetchImpl = vi.fn(async () => ok({ other_indicator: {} }));
    expect(await fetchPutCall({ fetchImpl, url: 'http://x/graphdata' })).toBeNull();
  });

  it('returns null when put_call_options.data is empty', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ put_call_options: { score: 50, rating: 'neutral', data: [] } }),
    );
    expect(await fetchPutCall({ fetchImpl, url: 'http://x/graphdata' })).toBeNull();
  });

  it('returns null when the response is non-ok (e.g. 418)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 418 }));
    expect(await fetchPutCall({ fetchImpl, url: 'http://x/graphdata' })).toBeNull();
  });

  it('passes browser headers including Referer and Origin', async () => {
    const fetchImpl = vi.fn(async () => ok(CNN_FIXTURE));
    await fetchPutCall({ fetchImpl, url: 'http://x/graphdata' });
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers['Referer']).toBe('https://www.cnn.com/markets/fear-and-greed');
    expect(headers['Origin']).toBe('https://www.cnn.com');
  });
});

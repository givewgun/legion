import { describe, it, expect, vi } from 'vitest';
import { fetchShortInterest } from '../../../src/data/feeds/finnhub.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

describe('fetchShortInterest', () => {
  it('returns null without an api key (never calls fetch)', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchShortInterest({ symbol: 'NVDA', apiKey: '', fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns the latest settlement value', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        symbol: 'NVDA',
        data: [
          { settlementDate: '2026-05-15', shortInterest: 1000 },
          { settlementDate: '2026-05-30', shortInterest: 1500 },
        ],
      }),
    );
    const res = await fetchShortInterest({ symbol: 'NVDA', apiKey: 'k', fetchImpl });
    expect(res).toEqual({ shortInterest: 1500, date: '2026-05-30' });
    expect(fetchImpl.mock.calls[0][0]).toContain('symbol=NVDA');
    expect(fetchImpl.mock.calls[0][0]).toContain('token=k');
  });

  it('returns null on an empty dataset', async () => {
    const fetchImpl = vi.fn(async () => ok({ data: [] }));
    expect(await fetchShortInterest({ symbol: 'MU', apiKey: 'k', fetchImpl })).toBeNull();
  });

  it('returns null when the endpoint errors (premium/403)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }));
    expect(await fetchShortInterest({ symbol: 'MU', apiKey: 'k', fetchImpl })).toBeNull();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { createGunvestClient, createGunvestFromConfig } from '../../src/data/gunvest.js';

function fetchReturning(payload) {
  return vi.fn(async () => ({ ok: true, json: async () => payload }));
}

describe('createGunvestClient', () => {
  it('fetches a ticker price from the market endpoint', async () => {
    const fetchMock = fetchReturning({ symbol: 'NVDA', price: 123.45 });
    const client = createGunvestClient('http://api:3001', fetchMock);
    const data = await client.getPrice('NVDA');
    expect(data).toEqual({ symbol: 'NVDA', price: 123.45 });
    expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/market/NVDA', expect.anything());
  });

  it('getFundamentals fetches the gunvest fundamentals endpoint', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ ticker: 'NVDA', trailingPE: 45, profitMargins: 0.5 }) };
    };
    const client = createGunvestClient('http://gv', fetchImpl);
    const f = await client.getFundamentals('nvda');
    expect(calls[0]).toBe('http://gv/api/stocks/NVDA/fundamentals');
    expect(f).toMatchObject({ ticker: 'NVDA', trailingPE: 45 });
  });

  it('fetches ticker news', async () => {
    const fetchMock = fetchReturning([{ headline: 'x' }]);
    const client = createGunvestClient('http://api:3001', fetchMock);
    await client.getNews('MU');
    expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/news/MU', expect.anything());
  });

  it('fetches sentiment', async () => {
    const fetchMock = fetchReturning({ score: 0.2 });
    const client = createGunvestClient('http://api:3001', fetchMock);
    await client.getSentiment('NVDA');
    expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/sentiment/NVDA', expect.anything());
  });

  it('fetches macro overview', async () => {
    const fetchMock = fetchReturning({ risk: 'MODERATE' });
    const client = createGunvestClient('http://api:3001', fetchMock);
    await client.getMacro();
    expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/macro', expect.anything());
  });

  it('fetches the equity (stock) fear & greed index', async () => {
    const fetchMock = fetchReturning({ value: 72, label: 'Greed' });
    const client = createGunvestClient('http://api:3001', fetchMock);
    const data = await client.getStockFearGreed();
    expect(data).toEqual({ value: 72, label: 'Greed' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api:3001/api/sentiment/stock/fear-greed',
      expect.anything(),
    );
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
      expect(fetchMock).toHaveBeenCalledWith(
        'http://x/api/market/NVDA/candles?days=30',
        expect.anything(),
      );
      expect(out).toEqual([
        { date: '2026-05-01', close: 100 },
        { date: '2026-05-02', close: 102 },
      ]);
    });

    it('throws on a non-ok candles response', async () => {
      const fetchMock = vi.fn(async () => ({ ok: false, status: 503 }));
      const client = createGunvestClient('http://x', fetchMock, { retries: 0 });
      await expect(client.getCandles('NVDA', 30)).rejects.toThrow(/503/);
    });
  });

  describe('resilience under burst', () => {
    it('retries a transient transport failure and then succeeds', async () => {
      let calls = 0;
      const fetchMock = vi.fn(async () => {
        calls += 1;
        if (calls < 3) {
          const err = new TypeError('fetch failed');
          err.cause = { code: 'ECONNRESET' };
          throw err;
        }
        return { ok: true, json: async () => ({ symbol: 'NVDA' }) };
      });
      const client = createGunvestClient('http://api', fetchMock, { retries: 3, retryBaseMs: 1 });
      const data = await client.getPrice('NVDA');
      expect(data).toEqual({ symbol: 'NVDA' });
      expect(calls).toBe(3);
    });

    it('gives up after exhausting retries and surfaces the underlying cause', async () => {
      const fetchMock = vi.fn(async () => {
        const err = new TypeError('fetch failed');
        err.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
        throw err;
      });
      const client = createGunvestClient('http://api', fetchMock, { retries: 2, retryBaseMs: 1 });
      await expect(client.getMacro()).rejects.toThrow(/UND_ERR_CONNECT_TIMEOUT/);
      expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('retries a 503 then succeeds', async () => {
      let calls = 0;
      const fetchMock = vi.fn(async () => {
        calls += 1;
        return calls < 2
          ? { ok: false, status: 503 }
          : { ok: true, json: async () => ({ ok: true }) };
      });
      const client = createGunvestClient('http://api', fetchMock, { retries: 3, retryBaseMs: 1 });
      await client.getMacro();
      expect(calls).toBe(2);
    });

    it('does NOT retry a deterministic 404 (fails fast)', async () => {
      const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
      const client = createGunvestClient('http://api', fetchMock, { retries: 3, retryBaseMs: 1 });
      await expect(client.getPrice('ZZZ')).rejects.toThrow('-> 404');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('caps the number of in-flight requests at maxConcurrent', async () => {
      let inFlight = 0;
      let peak = 0;
      const fetchMock = vi.fn(
        () =>
          new Promise((resolve) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            setTimeout(() => {
              inFlight -= 1;
              resolve({ ok: true, json: async () => ({}) });
            }, 5);
          }),
      );
      const client = createGunvestClient('http://api', fetchMock, { maxConcurrent: 2, retries: 0 });
      // getPrice is not deduped (unlike getMacro), so 8 calls genuinely contend.
      await Promise.all(Array.from({ length: 8 }, () => client.getPrice('NVDA')));
      expect(peak).toBeLessThanOrEqual(2);
    });

    it('dedupes concurrent macro fetches into one in-flight request', async () => {
      let calls = 0;
      const fetchMock = vi.fn(
        () =>
          new Promise((resolve) => {
            calls += 1;
            setTimeout(() => resolve({ ok: true, json: async () => ({ risk: 'LOW' }) }), 5);
          }),
      );
      const client = createGunvestClient('http://api', fetchMock, { macroTtlMs: 60000 });
      const results = await Promise.all(Array.from({ length: 5 }, () => client.getMacro()));
      expect(calls).toBe(1);
      expect(results.every((r) => r.risk === 'LOW')).toBe(true);
    });

    it('serves a cached macro snapshot within the TTL, then refetches after it', async () => {
      const fetchMock = fetchReturning({ risk: 'MODERATE' });
      const client = createGunvestClient('http://api', fetchMock, { macroTtlMs: 60000 });
      await client.getMacro();
      await client.getMacro();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const fresh = createGunvestClient('http://api', fetchMock, { macroTtlMs: 0 });
      await fresh.getMacro();
      await fresh.getMacro();
      expect(fetchMock).toHaveBeenCalledTimes(3); // ttl 0 disables caching
    });

    it('does not cache a failed macro fetch', async () => {
      let calls = 0;
      const fetchMock = vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          const err = new TypeError('fetch failed');
          err.cause = { code: 'ECONNRESET' };
          throw err;
        }
        return { ok: true, json: async () => ({ risk: 'HIGH' }) };
      });
      const client = createGunvestClient('http://api', fetchMock, {
        macroTtlMs: 60000,
        retries: 0,
      });
      await expect(client.getMacro()).rejects.toThrow(/ECONNRESET/);
      const data = await client.getMacro(); // retried, not the cached rejection
      expect(data).toEqual({ risk: 'HIGH' });
    });

    it('aborts a hung request via the timeout signal', async () => {
      const fetchMock = vi.fn(
        (url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      );
      const client = createGunvestClient('http://api', fetchMock, { retries: 0, timeoutMs: 10 });
      await expect(client.getMacro()).rejects.toThrow();
    });
  });

  describe('createGunvestFromConfig', () => {
    it('builds a client from config and applies the configured resilience knobs', async () => {
      const fetchMock = fetchReturning({ symbol: 'NVDA' });
      const cfg = {
        gunvestApiUrl: 'http://api:3001',
        gunvest: { timeoutMs: 15000, retries: 2, maxConcurrent: 6, macroTtlMs: 60000 },
      };
      const client = createGunvestFromConfig(cfg, fetchMock);
      await client.getPrice('NVDA');
      expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/market/NVDA', expect.anything());

      // macroTtlMs from config dedupes concurrent macro fetches.
      const macroFetch = fetchReturning({ risk: 'LOW' });
      const macroClient = createGunvestFromConfig(cfg, macroFetch);
      await Promise.all([macroClient.getMacro(), macroClient.getMacro()]);
      expect(macroFetch).toHaveBeenCalledTimes(1);
    });
  });
});

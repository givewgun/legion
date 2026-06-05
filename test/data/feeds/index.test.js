import { describe, it, expect, vi } from 'vitest';
import { createContrarianFeeds } from '../../../src/data/feeds/index.js';

const silent = { warn() {}, error() {} };

function makeGunvest(overrides = {}) {
  return {
    getStockFearGreed: vi.fn(async () => ({ value: 72, label: 'Greed' })),
    getMacro: vi.fn(async () => ({ vix: 18 })),
    ...overrides,
  };
}

describe('createContrarianFeeds', () => {
  it('merges all six positioning signals (gunvest reuse + net-new fetchers)', async () => {
    const gunvest = makeGunvest();
    // No finnhub key + no flaky-source urls -> those degrade to null; CBOE default
    // url is unreachable via this fetchImpl -> null too.
    const fetchImpl = vi.fn(async () => {
      throw new Error('network blocked in test');
    });
    const feeds = createContrarianFeeds({ gunvest, fetchImpl, logger: silent });

    const data = await feeds.gather('nvda');
    expect(data).toEqual({
      fearGreed: { value: 72, label: 'Greed' },
      vix: 18,
      putCall: null,
      aaii: null,
      naaim: null,
      shortInterest: null,
    });
  });

  it('degrades a single failing source to null without affecting the others', async () => {
    const gunvest = makeGunvest({
      getStockFearGreed: vi.fn(async () => {
        throw new Error('CNN down');
      }),
    });
    const feeds = createContrarianFeeds({
      gunvest,
      fetchImpl: vi.fn(async () => {
        throw new Error('blocked');
      }),
      logger: silent,
    });

    const data = await feeds.gather('MU');
    expect(data.fearGreed).toBeNull(); // failed source
    expect(data.vix).toBe(18); // unaffected
  });

  it('caches market-wide feeds across tickers within the TTL', async () => {
    const gunvest = makeGunvest();
    const feeds = createContrarianFeeds({
      gunvest,
      fetchImpl: vi.fn(async () => {
        throw new Error('blocked');
      }),
      logger: silent,
    });

    await feeds.gather('NVDA');
    await feeds.gather('MU');
    expect(gunvest.getMacro).toHaveBeenCalledTimes(1); // vix cached
    expect(gunvest.getStockFearGreed).toHaveBeenCalledTimes(1); // f&g cached
  });
});

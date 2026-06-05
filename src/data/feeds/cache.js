// Tiny in-process TTL memo. Contrarian feeds are market-wide (except short
// interest) and update daily/weekly, so a 6h scheduler sweep across many tickers
// must not re-hit each upstream source per ticker. `now` is injectable for tests.
export function createTtlCache(now = () => Date.now()) {
  const store = new Map();
  return {
    async getOrFetch(key, ttlMs, fn) {
      const hit = store.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.val;
      const val = await fn();
      store.set(key, { val, at: now() });
      return val;
    },
  };
}

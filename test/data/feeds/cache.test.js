import { describe, it, expect, vi } from 'vitest';
import { createTtlCache } from '../../../src/data/feeds/cache.js';

describe('createTtlCache', () => {
  it('returns the cached value within the TTL without re-calling fn', async () => {
    let clock = 1000;
    const cache = createTtlCache(() => clock);
    const fn = vi.fn(async () => 'v1');

    expect(await cache.getOrFetch('k', 5000, fn)).toBe('v1');
    clock = 3000; // still within ttl
    expect(await cache.getOrFetch('k', 5000, fn)).toBe('v1');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL has elapsed', async () => {
    let clock = 1000;
    const cache = createTtlCache(() => clock);
    const fn = vi.fn(async () => clock);

    await cache.getOrFetch('k', 5000, fn);
    clock = 7000; // past ttl
    const second = await cache.getOrFetch('k', 5000, fn);
    expect(second).toBe(7000);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

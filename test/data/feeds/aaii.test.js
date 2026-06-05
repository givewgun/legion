import { describe, it, expect, vi } from 'vitest';
import { fetchAaii } from '../../../src/data/feeds/aaii.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

describe('fetchAaii', () => {
  it('returns null when no source url is configured', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchAaii({ fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('parses bull/bear/neutral and derives the spread', async () => {
    const fetchImpl = vi.fn(async () => ok({ bullish: 0.45, bearish: 0.25, neutral: 0.3 }));
    const res = await fetchAaii({ fetchImpl, url: 'http://x/aaii.json' });
    expect(res).toEqual({ bullish: 0.45, bearish: 0.25, neutral: 0.3, spread: 0.2 });
  });

  it('returns null on an unexpected shape', async () => {
    const fetchImpl = vi.fn(async () => ok({ foo: 1 }));
    expect(await fetchAaii({ fetchImpl, url: 'http://x/aaii.json' })).toBeNull();
  });
});

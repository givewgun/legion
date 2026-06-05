import { describe, it, expect, vi } from 'vitest';
import { fetchNaaim } from '../../../src/data/feeds/naaim.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

describe('fetchNaaim', () => {
  it('returns null when no source url is configured', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchNaaim({ fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('parses the exposure value and date', async () => {
    const fetchImpl = vi.fn(async () => ok({ exposure: 72.5, date: '2026-06-04' }));
    const res = await fetchNaaim({ fetchImpl, url: 'http://x/naaim.json' });
    expect(res).toEqual({ exposure: 72.5, date: '2026-06-04' });
  });

  it('returns null on an unexpected shape', async () => {
    const fetchImpl = vi.fn(async () => ok({ nope: true }));
    expect(await fetchNaaim({ fetchImpl, url: 'http://x/naaim.json' })).toBeNull();
  });
});

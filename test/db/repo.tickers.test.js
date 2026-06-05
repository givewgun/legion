import { describe, it, expect, vi } from 'vitest';
import { createRepo } from '../../src/db/repo.js';
import { createDb } from '../../src/db/client.js';

describe('repo.listEnabledTickers', () => {
  it('returns the enabled ticker symbols', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{ symbol: 'NVDA' }, { symbol: 'MU' }] })),
    };
    const repo = createRepo(createDb(pool));
    const symbols = await repo.listEnabledTickers();
    expect(symbols).toEqual(['NVDA', 'MU']);
    const [text] = pool.query.mock.calls[0];
    expect(text).toMatch(/SELECT symbol FROM legion\.tickers/);
    expect(text).toMatch(/enabled/);
  });
});

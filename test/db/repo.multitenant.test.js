import { describe, it, expect, vi } from 'vitest';
import { createRepo } from '../../src/db/repo.js';

function fakeDb(rows = []) {
  return {
    query: vi.fn(async () => rows),
    queryOne: vi.fn(async () => rows[0] ?? null),
  };
}

describe('multitenant repo methods', () => {
  it('upsertUser upserts by google_sub and returns the row', async () => {
    const db = fakeDb([{ id: 7, email: 'a@b.com', name: 'A', avatar_url: 'x' }]);
    const repo = createRepo(db);
    const user = await repo.upsertUser({ googleSub: 'sub1', email: 'a@b.com', name: 'A', avatarUrl: 'x' });
    expect(user).toEqual({ id: 7, email: 'a@b.com', name: 'A', avatarUrl: 'x' });
    expect(db.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (google_sub)'),
      ['sub1', 'a@b.com', 'A', 'x'],
    );
  });

  it('listWatchlist returns sorted symbols', async () => {
    const db = fakeDb([{ symbol: 'AMD' }, { symbol: 'NVDA' }]);
    const repo = createRepo(db);
    expect(await repo.listWatchlist(7)).toEqual(['AMD', 'NVDA']);
  });

  it('addWatchlistSymbol upper-cases and ignores duplicates', async () => {
    const db = fakeDb();
    const repo = createRepo(db);
    await repo.addWatchlistSymbol(7, 'amd');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (user_id, symbol) DO NOTHING'),
      [7, 'AMD'],
    );
  });

  it('getPortfolioConfig maps snake_case to camelCase', async () => {
    const db = fakeDb([{ starting_cash: '50000.00', horizon_days: 10 }]);
    const repo = createRepo(db);
    expect(await repo.getPortfolioConfig(7)).toEqual({ startingCash: 50000, horizonDays: 10 });
  });

  it('getPortfolioConfig returns null when unset', async () => {
    const repo = createRepo(fakeDb([]));
    expect(await repo.getPortfolioConfig(7)).toBeNull();
  });
});

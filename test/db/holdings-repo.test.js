import { describe, it, expect } from 'vitest';
import { createRepo } from '../../src/db/repo.js';

// Minimal fake db: routes SQL by keyword to canned rows, records calls.
function fakeDb(rowsByMatch = {}) {
  const calls = [];
  const find = (sql) => Object.entries(rowsByMatch).find(([k]) => sql.includes(k))?.[1];
  return {
    calls,
    async query(sql, params) { calls.push({ sql, params }); return find(sql) ?? []; },
    async queryOne(sql, params) { calls.push({ sql, params }); const r = find(sql); return Array.isArray(r) ? r[0] : r ?? null; },
  };
}

describe('holdings repo', () => {
  it('lists holdings with numeric coercion', async () => {
    const db = fakeDb({
      'FROM legion.holdings': [
        { id: 1, ticker: 'NVDA', asset_type: 'stock', shares: '20', avg_cost: '177.04',
          total_cost: '3540.80', realized_pl: '0', dividends: '0', currency: 'USD',
          notes: null, updated_at: '2026-06-26T00:00:00Z' },
      ],
    });
    const repo = createRepo(db);
    const rows = await repo.listHoldings(7);
    expect(rows[0]).toMatchObject({ ticker: 'NVDA', shares: 20, avgCost: 177.04, totalCost: 3540.8, notes: null });
    expect(db.calls[0].params).toEqual([7]);
  });

  it('upsert derives total_cost from shares * avg_cost', async () => {
    const db = fakeDb({ 'INTO legion.holdings': { id: 1, ticker: 'NVDA', shares: '20', avg_cost: '177.04', total_cost: '3540.80', asset_type: 'stock', realized_pl: '0', dividends: '0', currency: 'USD', updated_at: 'x' } });
    const repo = createRepo(db);
    await repo.upsertHolding(7, { ticker: 'nvda', shares: 20, avgCost: 177.04 });
    const call = db.calls.find((c) => c.sql.includes('INTO legion.holdings'));
    expect(call.params).toContain('NVDA'); // upper-cased
    expect(call.params[5]).toBeCloseTo(3540.8, 4); // total_cost derived
  });

  it('delete returns true when a row was removed', async () => {
    const db = { async queryOne() { return { id: 1 }; }, async query() { return []; } };
    const repo = createRepo(db);
    expect(await repo.deleteHolding(7, 'NVDA')).toBe(true);
  });

  it('delete returns false when no row was removed', async () => {
    const db = { async queryOne() { return null; }, async query() { return []; } };
    const repo = createRepo(db);
    expect(await repo.deleteHolding(7, 'NVDA')).toBe(false);
  });
});

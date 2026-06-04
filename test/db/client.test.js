import { describe, it, expect, vi } from 'vitest';
import { createDb } from '../../src/db/client.js';

function fakePool(rows = []) {
  return { query: vi.fn(async () => ({ rows })) };
}

describe('createDb', () => {
  it('runs a query and returns rows', async () => {
    const pool = fakePool([{ symbol: 'NVDA' }]);
    const db = createDb(pool);
    const rows = await db.query('SELECT symbol FROM legion.tickers');
    expect(rows).toEqual([{ symbol: 'NVDA' }]);
    expect(pool.query).toHaveBeenCalledWith('SELECT symbol FROM legion.tickers', []);
  });

  it('passes parameters through', async () => {
    const pool = fakePool([]);
    const db = createDb(pool);
    await db.query('INSERT INTO legion.tickers(symbol) VALUES ($1)', ['MU']);
    expect(pool.query).toHaveBeenCalledWith('INSERT INTO legion.tickers(symbol) VALUES ($1)', [
      'MU',
    ]);
  });

  it('returns the first row via queryOne, or null', async () => {
    expect(await createDb(fakePool([{ id: 1 }])).queryOne('X')).toEqual({ id: 1 });
    expect(await createDb(fakePool([])).queryOne('X')).toBeNull();
  });
});

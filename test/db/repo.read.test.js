import { describe, it, expect, vi } from 'vitest';
import { createRepo } from '../../src/db/repo.js';
import { createDb } from '../../src/db/client.js';

function poolReturning(rowsList) {
  let i = 0;
  const calls = [];
  return {
    calls,
    query: vi.fn(async (text, params) => {
      calls.push({ text, params });
      const rows = rowsList[i] ?? [];
      i += 1;
      return { rows };
    }),
  };
}

describe('repo read + config methods', () => {
  it('lists all tickers ordered by symbol', async () => {
    const pool = poolReturning([
      [
        { symbol: 'MU', enabled: true },
        { symbol: 'NVDA', enabled: false },
      ],
    ]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.listTickers();
    expect(rows).toEqual([
      { symbol: 'MU', enabled: true },
      { symbol: 'NVDA', enabled: false },
    ]);
    expect(pool.calls[0].text).toMatch(/SELECT symbol, enabled FROM legion\.tickers/);
  });

  it('upserts a ticker as enabled', async () => {
    const pool = poolReturning([[{ symbol: 'AMD', enabled: true }]]);
    const repo = createRepo(createDb(pool));
    const row = await repo.upsertTicker('amd');
    expect(row).toEqual({ symbol: 'AMD', enabled: true });
    expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.tickers/);
    expect(pool.calls[0].text).toMatch(/ON CONFLICT/);
    expect(pool.calls[0].params).toEqual(['AMD']);
  });

  it('sets a ticker enabled flag', async () => {
    const pool = poolReturning([[{ symbol: 'NVDA', enabled: false }]]);
    const repo = createRepo(createDb(pool));
    const row = await repo.setTickerEnabled('nvda', false);
    expect(row).toEqual({ symbol: 'NVDA', enabled: false });
    expect(pool.calls[0].text).toMatch(/UPDATE legion\.tickers SET enabled/);
    expect(pool.calls[0].params).toEqual([false, 'NVDA']);
  });

  it('lists recent cycles for a symbol', async () => {
    const pool = poolReturning([[{ id: 9, symbol: 'NVDA', status: 'converged' }]]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.listCycles('nvda', 20);
    expect(rows[0].id).toBe(9);
    expect(pool.calls[0].text).toMatch(/FROM legion\.cycles/);
    expect(pool.calls[0].params).toEqual(['NVDA', 20]);
  });

  it('fetches a single cycle', async () => {
    const pool = poolReturning([[{ id: 9, symbol: 'NVDA', status: 'converged' }]]);
    const repo = createRepo(createDb(pool));
    const row = await repo.getCycle(9);
    expect(row).toEqual({ id: 9, symbol: 'NVDA', status: 'converged' });
    expect(pool.calls[0].params).toEqual([9]);
  });

  it('fetches rounds for a cycle ordered by round number', async () => {
    const pool = poolReturning([
      [{ id: 1, round_no: 1, s_score: 1.5, dispersion: 0.1, quorum: 0.8, converged: true }],
    ]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.getRounds(9);
    expect(rows[0].round_no).toBe(1);
    expect(pool.calls[0].text).toMatch(/FROM legion\.rounds WHERE cycle_id/);
    expect(pool.calls[0].params).toEqual([9]);
  });

  it('fetches votes for a round', async () => {
    const pool = poolReturning([
      [{ agent_id: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' }],
    ]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.getVotes(1);
    expect(rows[0].agent_id).toBe('technical');
    expect(pool.calls[0].text).toMatch(/FROM legion\.votes WHERE round_id/);
    expect(pool.calls[0].params).toEqual([1]);
  });

  it('lists recent signals optionally filtered by symbol', async () => {
    const pool = poolReturning([
      [{ id: 3, symbol: 'NVDA', band: 'STRONG_BUY', conviction: 0.9, plan: {} }],
    ]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.listSignals('nvda', 50);
    expect(rows[0].band).toBe('STRONG_BUY');
    expect(pool.calls[0].text).toMatch(/FROM legion\.signals/);
    expect(pool.calls[0].params).toEqual(['NVDA', 50]);
  });

  it('lists recent signals across all symbols when symbol is null', async () => {
    const pool = poolReturning([[{ id: 3, symbol: 'MU' }]]);
    const repo = createRepo(createDb(pool));
    await repo.listSignals(null, 50);
    expect(pool.calls[0].text).not.toMatch(/WHERE symbol/);
    expect(pool.calls[0].params).toEqual([50]);
  });
});

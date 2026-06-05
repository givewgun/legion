import { describe, it, expect, vi } from 'vitest';
import { createRepo } from '../../src/db/repo.js';
import { createDb } from '../../src/db/client.js';

function poolReturning(idRows) {
  const calls = [];
  let i = 0;
  return {
    calls,
    query: vi.fn(async (text, params) => {
      calls.push({ text, params });
      const rows = idRows[i] ?? [];
      i += 1;
      return { rows };
    }),
  };
}

describe('createRepo', () => {
  it('creates a cycle and returns its id', async () => {
    const pool = poolReturning([[{ id: 42 }]]);
    const repo = createRepo(createDb(pool));
    const id = await repo.createCycle('NVDA');
    expect(id).toBe(42);
    expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.cycles/);
    expect(pool.calls[0].params).toEqual(['NVDA']);
  });

  it('adds a round and returns its id', async () => {
    const pool = poolReturning([[{ id: 5 }]]);
    const repo = createRepo(createDb(pool));
    const id = await repo.addRound(42, 1, { S: 1.8, V: 0, kappa: 1, converged: true });
    expect(id).toBe(5);
    expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.rounds/);
    expect(pool.calls[0].params).toEqual([42, 1, 1.8, 0, 1, true]);
  });

  it('adds a vote', async () => {
    const pool = poolReturning([[{ id: 1 }]]);
    const repo = createRepo(createDb(pool));
    await repo.addVote(5, {
      agentId: 'technical',
      stance: 2,
      conviction: 0.9,
      weight: 1,
      rationale: 'breakout',
    });
    expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.votes/);
    expect(pool.calls[0].params).toEqual([5, 'technical', 2, 0.9, 1, 'breakout']);
  });

  it('adds a signal with a JSONB plan', async () => {
    const pool = poolReturning([[{ id: 3 }]]);
    const repo = createRepo(createDb(pool));
    const id = await repo.addSignal(42, {
      symbol: 'NVDA',
      band: 'STRONG_BUY',
      conviction: 0.9,
      plan: { horizon: 'swing' },
    });
    expect(id).toBe(3);
    expect(pool.calls[0].params[0]).toBe(42);
    expect(pool.calls[0].params[1]).toBe('NVDA');
    expect(pool.calls[0].params[2]).toBe('STRONG_BUY');
    expect(pool.calls[0].params[4]).toBe(JSON.stringify({ horizon: 'swing' }));
  });

  it('finishes a cycle with a status', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.finishCycle(42, 'converged');
    expect(pool.calls[0].text).toMatch(/UPDATE legion\.cycles/);
    expect(pool.calls[0].params).toEqual(['converged', 42]);
  });
});

import { describe, it, expect } from 'vitest';
import { createRepo } from '../../src/db/repo.js';
import { createDb } from '../../src/db/client.js';

function poolReturning(rows) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows };
    },
  };
}

describe('listSignalsSince', () => {
  it('selects signals on/after the cutoff, newest first, mapping band to stance', async () => {
    const pool = poolReturning([
      { symbol: 'NVDA', band: 'STRONG_BUY', conviction: 0.9, created_at: '2026-06-04T05:00:00Z' },
    ]);
    const repo = createRepo(createDb(pool));
    const out = await repo.listSignalsSince('2026-06-04T00:00:00Z');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      symbol: 'NVDA',
      stance: 2,
      conviction: 0.9,
      created_at: '2026-06-04T05:00:00Z',
    });
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('from legion.signals');
    expect(text.toLowerCase()).toContain('created_at >=');
    expect(text.toLowerCase()).toContain('order by created_at desc');
    expect(params).toEqual(['2026-06-04T00:00:00Z']);
  });

  it('maps NO_CONSENSUS / unknown bands to stance 0', async () => {
    const pool = poolReturning([
      { symbol: 'AMD', band: 'NO_CONSENSUS', conviction: 0.1, created_at: 'T' },
    ]);
    const repo = createRepo(createDb(pool));
    const out = await repo.listSignalsSince('2026-06-04T00:00:00Z');
    expect(out[0].stance).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { recomputeCorrelations } from '../../src/reliability/correlations.js';

describe('recomputeCorrelations', () => {
  it('persists each co-rated agent pair and returns them', async () => {
    const rows = [];
    for (let signal = 1; signal <= 6; signal += 1) {
      const stance = signal % 2 === 0 ? 2 : 1;
      rows.push({ signal_id: signal, agent_id: 'technical', stance });
      rows.push({ signal_id: signal, agent_id: 'news', stance }); // perfect echo
    }
    const writes = [];
    const repo = {
      getVoteHistory: async () => rows,
      upsertCorrelation: async (a, b, corr, n) => writes.push({ a, b, corr, n }),
    };
    const pairs = await recomputeCorrelations(repo);
    expect(pairs).toHaveLength(1);
    expect(writes[0]).toMatchObject({ a: 'news', b: 'technical', n: 6 });
    expect(writes[0].corr).toBeCloseTo(1);
  });

  it('persists nothing when there is no co-rated history', async () => {
    const writes = [];
    const repo = {
      getVoteHistory: async () => [],
      upsertCorrelation: async (...args) => writes.push(args),
    };
    expect(await recomputeCorrelations(repo)).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });
});

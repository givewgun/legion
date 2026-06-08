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
    let replaced = null;
    const repo = {
      getVoteHistory: async () => rows,
      replaceCorrelations: async (pairs) => {
        replaced = pairs;
      },
    };
    const pairs = await recomputeCorrelations(repo);
    expect(pairs).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ a: 'news', b: 'technical', n: 6 });
    expect(replaced[0].corr).toBeCloseTo(1);
  });

  it('replaces with an empty set when there is no co-rated history (clears stale rows)', async () => {
    let replaced = null;
    const repo = {
      getVoteHistory: async () => [],
      replaceCorrelations: async (pairs) => {
        replaced = pairs;
      },
    };
    expect(await recomputeCorrelations(repo)).toHaveLength(0);
    expect(replaced).toEqual([]); // called with [] so the table is cleared, not left stale
  });
});

import { describe, it, expect, vi } from 'vitest';
import { createRepo } from '../../src/db/repo.js';
import { createDb } from '../../src/db/client.js';

function poolReturning(rowsByCall) {
  const calls = [];
  let i = 0;
  return {
    calls,
    query: vi.fn(async (text, params) => {
      calls.push({ text, params });
      const rows = rowsByCall[i] ?? [];
      i += 1;
      return { rows };
    }),
  };
}

describe('repo agent_correlation', () => {
  it('getVoteHistory pulls stances for the most recent N signals', async () => {
    const pool = poolReturning([[{ signal_id: 2, agent_id: 'technical', stance: 1 }]]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.getVoteHistory(200);
    expect(rows).toHaveLength(1);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('from legion.signal_votes');
    expect(text.toLowerCase()).toContain('order by id desc limit');
    expect(params).toEqual([200]);
  });

  it('replaceCorrelations clears the table then bulk-inserts the new pairs', async () => {
    const pool = poolReturning([[], []]);
    const repo = createRepo(createDb(pool));
    await repo.replaceCorrelations([
      { a: 'news', b: 'technical', corr: 0.8, n: 12 },
      { a: 'social', b: 'technical', corr: -0.3, n: 9 },
    ]);
    expect(pool.calls[0].text.toLowerCase()).toContain('delete from legion.agent_correlation');
    const insert = pool.calls[1];
    expect(insert.text.toLowerCase()).toContain('insert into legion.agent_correlation');
    expect(insert.params).toEqual(['news', 'technical', 0.8, 12, 'social', 'technical', -0.3, 9]);
  });

  it('replaceCorrelations with no pairs clears the table and skips the insert', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.replaceCorrelations([]);
    expect(pool.calls).toHaveLength(1); // delete only, no insert
    expect(pool.calls[0].text.toLowerCase()).toContain('delete from legion.agent_correlation');
  });

  it('getAgentCorrelations builds a symmetric nested lookup', async () => {
    const pool = poolReturning([[{ agent_a: 'news', agent_b: 'technical', corr: 0.8 }]]);
    const repo = createRepo(createDb(pool));
    const map = await repo.getAgentCorrelations();
    expect(map.news.technical).toBeCloseTo(0.8);
    expect(map.technical.news).toBeCloseTo(0.8); // mirrored
  });
});

import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { createRepo } from '../../src/db/repo.js';

function poolReturning(results) {
  const calls = [];
  let i = 0;
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: results[i++] ?? [] };
    },
  };
}

describe('repo pending state (ADR 0024)', () => {
  it('savePendingVote upserts the serialized vote keyed by (cycle, round, agent)', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    const vote = { agentId: 'technical', stance: 1, conviction: 0.8, weight: 1, rationale: 'r' };
    await repo.savePendingVote(7, 1, 'NVDA', vote);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('insert into legion.pending_votes');
    expect(text.toLowerCase()).toContain('on conflict');
    expect(params).toEqual([7, 1, 'NVDA', 'technical', JSON.stringify(vote)]);
  });

  it('savePendingConstraint upserts keyed by (cycle, round)', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.savePendingConstraint(7, 1, 'NVDA', { capConviction: 0.5 });
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('insert into legion.pending_constraints');
    expect(params).toEqual([7, 1, 'NVDA', '{"capConviction":0.5}']);
  });

  it('loadPendingVotes returns ALL rows of recently-active cycles, not just recent rows', async () => {
    const rows = [{ cycle_id: 7, round: 1, symbol: 'NVDA', vote: { agentId: 'technical' } }];
    const pool = poolReturning([rows]);
    const repo = createRepo(createDb(pool));
    const out = await repo.loadPendingVotes('2026-06-04T00:00:00Z');
    expect(out).toEqual(rows);
    // Cycle-level cutoff: a slow cycle's early votes must survive recovery, so
    // recency is judged per cycle (any row in either table), not per row.
    const sql = pool.calls[0].text.toLowerCase();
    expect(sql).toContain('created_at >=');
    expect(sql).toContain('union');
    expect(sql).toContain('legion.pending_constraints');
    expect(pool.calls[0].params).toEqual(['2026-06-04T00:00:00Z']);
  });

  it('loadPendingConstraints uses the same cycle-level cutoff', async () => {
    const rows = [{ cycle_id: 7, round: 1, symbol: 'NVDA', payload: { capConviction: 0.5 } }];
    const pool = poolReturning([rows]);
    const repo = createRepo(createDb(pool));
    const out = await repo.loadPendingConstraints('2026-06-04T00:00:00Z');
    expect(out).toEqual(rows);
    const sql = pool.calls[0].text.toLowerCase();
    expect(sql).toContain('union');
    expect(sql).toContain('legion.pending_votes');
  });

  it('deletePendingCycle clears both tables for the cycle', async () => {
    const pool = poolReturning([[], []]);
    const repo = createRepo(createDb(pool));
    await repo.deletePendingCycle(7);
    expect(pool.calls[0].text.toLowerCase()).toContain('delete from legion.pending_votes');
    expect(pool.calls[1].text.toLowerCase()).toContain('delete from legion.pending_constraints');
    expect(pool.calls[0].params).toEqual([7]);
  });

  it('deletePendingBefore only deletes rows of cycles with NO recent activity in either table', async () => {
    const pool = poolReturning([[], []]);
    const repo = createRepo(createDb(pool));
    await repo.deletePendingBefore('2026-06-04T00:00:00Z');
    expect(pool.calls).toHaveLength(2);
    // A slow-but-alive cycle keeps refreshing rows; its OLD rows (early votes,
    // the one-shot risk constraint) must be spared or a restart strands it.
    for (const call of pool.calls) {
      const sql = call.text.toLowerCase();
      expect(sql).toContain('delete from');
      expect(sql).toContain('not in');
      expect(sql).toContain('created_at >=');
      expect(sql).toContain('union');
      expect(call.params).toEqual(['2026-06-04T00:00:00Z']);
    }
  });

  it('roundExists reports whether a round was already aggregated', async () => {
    const pool = poolReturning([[{ one: 1 }], []]);
    const repo = createRepo(createDb(pool));
    expect(await repo.roundExists(7, 1)).toBe(true);
    expect(await repo.roundExists(7, 2)).toBe(false);
  });

  it('cycleHasSignal reports whether the cycle already emitted', async () => {
    const pool = poolReturning([[{ one: 1 }], []]);
    const repo = createRepo(createDb(pool));
    expect(await repo.cycleHasSignal(7)).toBe(true);
    expect(await repo.cycleHasSignal(8)).toBe(false);
    expect(pool.calls[0].text.toLowerCase()).toContain('from legion.signals');
  });

  it('timeoutStaleCycles closes abandoned running cycles, sparing the active ids', async () => {
    const rows = [{ id: 8, symbol: 'MU' }];
    const pool = poolReturning([rows]);
    const repo = createRepo(createDb(pool));
    const out = await repo.timeoutStaleCycles('2026-06-11T21:30:00Z', [9, 12]);
    expect(out).toEqual(rows);
    const { text, params } = pool.calls[0];
    const sql = text.toLowerCase();
    expect(sql).toContain('update legion.cycles');
    expect(sql).toContain(`status = 'timeout'`);
    expect(sql).toContain(`status = 'running'`);
    expect(sql).toContain('started_at <');
    expect(params).toEqual(['2026-06-11T21:30:00Z', [9, 12]]);
  });
});

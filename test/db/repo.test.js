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
    const id = await repo.addRound(42, 1, { S: 1.8, V: 0, kappa: 1, A: 0.85, converged: true });
    expect(id).toBe(5);
    expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.rounds/);
    expect(pool.calls[0].text).toMatch(/ON CONFLICT \(cycle_id, round_no\) DO NOTHING/);
    expect(pool.calls[0].params).toEqual([42, 1, 1.8, 0, 1, 0.85, true]);
  });

  it('returns null from addRound when the round already exists (ON CONFLICT)', async () => {
    const pool = poolReturning([[]]); // conflict -> no row returned
    const repo = createRepo(createDb(pool));
    const id = await repo.addRound(42, 1, { S: 1.8, V: 0, kappa: 1, A: 0.85, converged: true });
    expect(id).toBeNull();
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

  it('addSignalVotes inserts the served model, defaulting null to the oracle model', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.addSignalVotes(7, [
      { agentId: 'news', stance: 1, conviction: 0.7, weight: 1.2, model: 'gpt-oss:20b' },
      { agentId: 'social', stance: 0, conviction: 0, weight: 0.8, model: null },
    ]);
    expect(pool.calls[0].text).toContain(
      'legion.signal_votes (signal_id, agent_id, stance, conviction, weight, model)',
    );
    expect(pool.calls[0].params).toEqual([
      7, 'news', 1, 0.7, 1.2, 'gpt-oss:20b',
      7, 'social', 0, 0, 0.8, 'qwen2.5:7b-instruct',
    ]);
  });

  it('getAllReliability returns a nested agent->model->rho map', async () => {
    const pool = poolReturning([
      [
        { agent_id: 'news', model: 'gpt-oss:20b', rho: 1.3 },
        { agent_id: 'news', model: 'qwen2.5:7b-instruct', rho: 0.9 },
      ],
    ]);
    const repo = createRepo(createDb(pool));
    expect(await repo.getAllReliability()).toEqual({
      news: { 'gpt-oss:20b': 1.3, 'qwen2.5:7b-instruct': 0.9 },
    });
  });

  it('getFlooredStreaks returns a nested agent->model->streak map', async () => {
    const pool = poolReturning([
      [
        { agent_id: 'news', model: 'qwen2.5:7b-instruct', floored_streak: 3 },
        { agent_id: 'social', model: 'qwen2.5:7b-instruct', floored_streak: 0 },
      ],
    ]);
    const repo = createRepo(createDb(pool));
    expect(await repo.getFlooredStreaks()).toEqual({
      news: { 'qwen2.5:7b-instruct': 3 },
      social: { 'qwen2.5:7b-instruct': 0 },
    });
  });

  it('upsertReliability includes model in conflict target', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.upsertReliability('news', 'gpt-oss:20b', 1.3, 10, 0.9, 1.1);
    expect(pool.calls[0].text).toContain('ON CONFLICT (agent_id, model)');
    expect(pool.calls[0].params).toEqual(['news', 'gpt-oss:20b', 1.3, 10, 0.9, 1.1]);
  });

  it('updateRosterFlag uses model as part of WHERE clause', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.updateRosterFlag('news', 'qwen2.5:7b-instruct', 5, true);
    expect(pool.calls[0].text).toContain('WHERE agent_id = $1 AND model = $2');
    expect(pool.calls[0].params).toEqual(['news', 'qwen2.5:7b-instruct', 5, true]);
  });

  it('getReliabilityLeaderboard includes model in returned objects', async () => {
    const pool = poolReturning([
      [
        {
          agent_id: 'news',
          model: 'gpt-oss:20b',
          rho: 1.3,
          sample_size: 10,
          calibration: 0.9,
          info_factor: 1.1,
          learned_prior: null,
          floored_streak: 0,
          flagged: false,
        },
      ],
    ]);
    const repo = createRepo(createDb(pool));
    const leaderboard = await repo.getReliabilityLeaderboard();
    expect(leaderboard[0]).toMatchObject({ agentId: 'news', model: 'gpt-oss:20b', rho: 1.3 });
  });

  it('getHomePcEnabled returns true when no row exists', async () => {
    const pool = poolReturning([[]]); // queryOne returns undefined
    const repo = createRepo(createDb(pool));
    expect(await repo.getHomePcEnabled()).toBe(true);
  });

  it('getHomePcEnabled returns false when the row value is "false"', async () => {
    const pool = poolReturning([[{ value: 'false' }]]);
    const repo = createRepo(createDb(pool));
    expect(await repo.getHomePcEnabled()).toBe(false);
  });

  it('getHomePcEnabled returns true when the row value is "true"', async () => {
    const pool = poolReturning([[{ value: 'true' }]]);
    const repo = createRepo(createDb(pool));
    expect(await repo.getHomePcEnabled()).toBe(true);
  });

  it('setHomePcEnabled upserts the key with the string value', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.setHomePcEnabled(false);
    expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.runtime_config/);
    expect(pool.calls[0].params).toEqual(['false']);
  });
});

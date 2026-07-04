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
    const id = await repo.addRound(42, 1, {
      S: 1.8,
      V: 0,
      kappa: 1,
      A: 0.85,
      drift: 2,
      converged: true,
    });
    expect(id).toBe(5);
    expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.rounds/);
    expect(pool.calls[0].text).toMatch(/ON CONFLICT \(cycle_id, round_no\) DO NOTHING/);
    expect(pool.calls[0].params).toEqual([42, 1, 1.8, 0, 1, 0.85, 2, true]);
  });

  it('returns null from addRound when the round already exists (ON CONFLICT)', async () => {
    const pool = poolReturning([[]]); // conflict -> no row returned
    const repo = createRepo(createDb(pool));
    const id = await repo.addRound(42, 1, { S: 1.8, V: 0, kappa: 1, A: 0.85, converged: true });
    expect(id).toBeNull();
  });

  it('lists running cycles', async () => {
    const pool = poolReturning([[{ id: 1, symbol: 'NVDA' }]]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.listRunningCycles();
    expect(rows).toEqual([{ id: 1, symbol: 'NVDA' }]);
    expect(pool.calls[0].text).toMatch(/WHERE status = 'running'/);
  });

  it('stops the running cycles of a symbol and returns the closed rows', async () => {
    const pool = poolReturning([[{ id: 1, symbol: 'NVDA' }]]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.stopRunningCycles('NVDA');
    expect(rows).toEqual([{ id: 1, symbol: 'NVDA' }]);
    expect(pool.calls[0].text).toMatch(/SET status = 'stopped'/);
    expect(pool.calls[0].params).toEqual(['NVDA']);
  });

  it('resets reliability by clearing the dial tables and forecast snapshots', async () => {
    const pool = poolReturning([[{ one: 1 }, { one: 1 }], [], [{ one: 1 }], [], [{ one: 1 }]]);
    const repo = createRepo(createDb(pool));
    const cleared = await repo.resetReliability();
    expect(cleared).toEqual({
      agent_reliability: 2,
      agent_regime_reliability: 0,
      agent_correlation: 1,
      agent_lessons: 0,
      signal_votes: 1,
    });
    const tables = pool.calls.map((c) => c.text);
    expect(tables.some((t) => t.includes('legion.signal_votes'))).toBe(true);
    // signals themselves are never touched — trade history survives a reset
    expect(tables.every((t) => !/DELETE FROM legion\.signals\b/.test(t))).toBe(true);
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
    expect(pool.calls[0].params).toEqual([5, 'technical', 2, 0.9, 1, 'breakout', null, null, null]);
  });

  it('addVote includes thought, model and source in INSERT params', async () => {
    const pool = poolReturning([[{ id: 2 }]]);
    const repo = createRepo(createDb(pool));
    await repo.addVote(5, {
      agentId: 'news',
      stance: 1,
      conviction: 0.5,
      weight: 1,
      rationale: 'r',
      thought: 'step 1: the catalyst is priced in',
      model: 'gpt-oss:20b',
      source: 'pc',
    });
    expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.votes/);
    expect(pool.calls[0].text).toContain('thought');
    expect(pool.calls[0].text).toContain('model');
    expect(pool.calls[0].text).toContain('source');
    expect(pool.calls[0].params).toEqual([5, 'news', 1, 0.5, 1, 'r', 'step 1: the catalyst is priced in', 'gpt-oss:20b', 'pc']);
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

  it('getRuntimeConfig returns an empty map when no rows exist', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    expect(await repo.getRuntimeConfig()).toEqual({});
  });

  it('getRuntimeConfig maps key/value rows', async () => {
    const pool = poolReturning([
      [
        { key: 'home_pc_enabled', value: 'false' },
        { key: 'home_model', value: 'qwen3:8b' },
      ],
    ]);
    const repo = createRepo(createDb(pool));
    expect(await repo.getRuntimeConfig()).toEqual({
      home_pc_enabled: 'false',
      home_model: 'qwen3:8b',
    });
  });

  it('setRuntimeConfig upserts the key with the stringified value', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.setRuntimeConfig('home_timeout_ms', 600000);
    expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.runtime_config/);
    expect(pool.calls[0].params).toEqual(['home_timeout_ms', '600000']);
  });

  it('deleteRuntimeConfig removes the key', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.deleteRuntimeConfig('home_model');
    expect(pool.calls[0].text).toMatch(/DELETE FROM legion\.runtime_config/);
    expect(pool.calls[0].params).toEqual(['home_model']);
  });

  describe('order intents', () => {
    it('addOrderIntent inserts pending and returns id', async () => {
      const pool = poolReturning([[{ id: 7 }]]);
      const repo = createRepo(createDb(pool));
      const id = await repo.addOrderIntent({ signalId: 3, symbol: 'AAPL', band: 'BUY', conviction: 0.8, qualityMult: 1.2 });
      expect(id).toBe(7);
      expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.order_intents/);
      expect(pool.calls[0].params).toEqual([3, 'AAPL', 'BUY', 0.8, 1.2]);
    });

    it('listOrderIntentsByStatus orders by created_at ASC', async () => {
      const pool = poolReturning([
        [
          { id: 1, signal_id: 3, symbol: 'AAPL', band: 'BUY', conviction: 0.8, quality_mult: 1.2, target_weight: null, status: 'pending', skip_reason: null, broker_order_id: null, submitted_qty: null, fill_qty: null, fill_price: null, error: null, created_at: '2025-01-01T00:00:00Z' },
        ],
      ]);
      const repo = createRepo(createDb(pool));
      const rows = await repo.listOrderIntentsByStatus('pending');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(1);
      expect(rows[0].signalId).toBe(3);
      expect(rows[0].status).toBe('pending');
      expect(pool.calls[0].text).toMatch(/ORDER BY created_at ASC/);
      expect(pool.calls[0].params).toEqual(['pending']);
    });

    it('updateOrderIntent patches only given keys', async () => {
      const pool = poolReturning([[]]);
      const repo = createRepo(createDb(pool));
      await repo.updateOrderIntent(7, { status: 'submitted', brokerOrderId: 'X1', submittedQty: 10 });
      expect(pool.calls[0].text).toMatch(/UPDATE legion\.order_intents SET/);
      expect(pool.calls[0].text).toMatch(/updated_at = now\(\)/);
      expect(pool.calls[0].params).toContain('submitted');
      expect(pool.calls[0].params).toContain('X1');
      expect(pool.calls[0].params).toContain(10);
    });

    it('updateOrderIntent rejects unknown keys', async () => {
      const pool = poolReturning([[]]);
      const repo = createRepo(createDb(pool));
      await expect(repo.updateOrderIntent(7, { nope: 1 })).rejects.toThrow(/unknown/i);
    });

    it('updateOrderIntent rejects an empty patch', async () => {
      const pool = poolReturning([[]]);
      const repo = createRepo(createDb(pool));
      await expect(repo.updateOrderIntent(7, {})).rejects.toThrow(/empty patch/i);
      expect(pool.calls).toHaveLength(0);
    });

    it('listOrderIntents orders by created_at DESC with limit', async () => {
      const pool = poolReturning([
        [
          { id: 2, signal_id: 4, symbol: 'TSLA', band: 'SELL', conviction: 0.7, quality_mult: 0.9, target_weight: null, status: 'pending', skip_reason: null, broker_order_id: null, submitted_qty: null, fill_qty: null, fill_price: null, error: null, created_at: '2025-01-02T00:00:00Z' },
          { id: 1, signal_id: 3, symbol: 'AAPL', band: 'BUY', conviction: 0.8, quality_mult: 1.2, target_weight: null, status: 'pending', skip_reason: null, broker_order_id: null, submitted_qty: null, fill_qty: null, fill_price: null, error: null, created_at: '2025-01-01T00:00:00Z' },
        ],
      ]);
      const repo = createRepo(createDb(pool));
      const rows = await repo.listOrderIntents(100);
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(2);
      expect(rows[1].id).toBe(1);
      expect(pool.calls[0].text).toMatch(/ORDER BY created_at DESC LIMIT/);
      expect(pool.calls[0].params).toEqual([100]);
    });
  });

  describe('equity snapshots', () => {
    it('addEquitySnapshot inserts equity and cash', async () => {
      const pool = poolReturning([[]]);
      const repo = createRepo(createDb(pool));
      await repo.addEquitySnapshot({ equity: 50000, cash: 5000 });
      expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.paper_equity_snapshots/);
      expect(pool.calls[0].params).toEqual([50000, 5000]);
    });

    it('listEquitySnapshots returns ordered by ts ASC', async () => {
      const pool = poolReturning([
        [
          { ts: '2025-01-01T00:00:00Z', equity: 50000, cash: 5000 },
          { ts: '2025-01-02T00:00:00Z', equity: 51000, cash: 4900 },
        ],
      ]);
      const repo = createRepo(createDb(pool));
      const rows = await repo.listEquitySnapshots();
      expect(rows).toHaveLength(2);
      expect(rows[0].equity).toBe(50000);
      expect(rows[0].cash).toBe(5000);
      expect(rows[1].equity).toBe(51000);
      expect(rows[1].cash).toBe(4900);
      expect(pool.calls[0].text).toMatch(/ORDER BY ts ASC/);
    });
  });
});

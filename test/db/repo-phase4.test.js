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

describe('repo phase4', () => {
  it('getAllReliability returns a nested agentId->model->rho map', async () => {
    const pool = poolReturning([
      [
        { agent_id: 'technical', model: 'qwen2.5:7b-instruct', rho: 1.3 },
        { agent_id: 'news', model: 'qwen2.5:7b-instruct', rho: 0.9 },
      ],
    ]);
    const repo = createRepo(createDb(pool));
    const map = await repo.getAllReliability();
    expect(map).toEqual({
      technical: { 'qwen2.5:7b-instruct': 1.3 },
      news: { 'qwen2.5:7b-instruct': 0.9 },
    });
    expect(pool.calls[0].text.toLowerCase()).toContain('from legion.agent_reliability');
  });

  it('upsertReliability upserts rho + sample_size + calibration + info keyed by model', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.upsertReliability('technical', 'qwen2.5:7b-instruct', 1.25, 12, 1.3, 0.6);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('insert into legion.agent_reliability');
    expect(text.toLowerCase()).toContain('on conflict (agent_id, model)');
    expect(params).toEqual(['technical', 'qwen2.5:7b-instruct', 1.25, 12, 1.3, 0.6]);
  });

  it('upsertReliability defaults calibration and info to neutral 1.0', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.upsertReliability('technical', 'qwen2.5:7b-instruct', 1.25, 12);
    expect(pool.calls[0].params).toEqual(['technical', 'qwen2.5:7b-instruct', 1.25, 12, 1.0, 1.0]);
  });

  it('regime reliability round-trips per-(agent, regime, model) dials', async () => {
    const pool = poolReturning([
      [],
      [{ agent_id: 'technical', model: 'qwen2.5:7b-instruct', rho: 1.4 }],
      [{ agent_id: 'technical', model: 'qwen2.5:7b-instruct', calibration: 1.2 }],
    ]);
    const repo = createRepo(createDb(pool));
    await repo.upsertRegimeReliability('technical', 'stressed', 'qwen2.5:7b-instruct', 1.4, 12, 1.2);
    expect(pool.calls[0].text.toLowerCase()).toContain('legion.agent_regime_reliability');
    expect(pool.calls[0].params).toEqual(['technical', 'stressed', 'qwen2.5:7b-instruct', 1.4, 1.2, 12]);
    expect(await repo.getRegimeReliability('stressed')).toEqual({
      technical: { 'qwen2.5:7b-instruct': 1.4 },
    });
    expect(pool.calls[1].params).toEqual(['stressed']);
    expect(await repo.getRegimeCalibration('stressed')).toEqual({
      technical: { 'qwen2.5:7b-instruct': 1.2 },
    });
  });

  it('getAgentInfoFactors returns a nested agentId->model->info map', async () => {
    const pool = poolReturning([
      [
        { agent_id: 'technical', model: 'qwen2.5:7b-instruct', info_factor: 1.0 },
        { agent_id: 'social', model: 'qwen2.5:7b-instruct', info_factor: 0.25 },
      ],
    ]);
    const repo = createRepo(createDb(pool));
    const map = await repo.getAgentInfoFactors();
    expect(map).toEqual({
      technical: { 'qwen2.5:7b-instruct': 1.0 },
      social: { 'qwen2.5:7b-instruct': 0.25 },
    });
  });

  it('getAgentCalibration returns a nested agentId->model->calibration map', async () => {
    const pool = poolReturning([
      [
        { agent_id: 'technical', model: 'qwen2.5:7b-instruct', calibration: 1.4 },
        { agent_id: 'news', model: 'qwen2.5:7b-instruct', calibration: 0.8 },
      ],
    ]);
    const repo = createRepo(createDb(pool));
    const map = await repo.getAgentCalibration();
    expect(map).toEqual({
      technical: { 'qwen2.5:7b-instruct': 1.4 },
      news: { 'qwen2.5:7b-instruct': 0.8 },
    });
    expect(pool.calls[0].text.toLowerCase()).toContain('calibration');
  });

  it('addSignal persists entry/benchmark/horizon/resolve_after and returns id', async () => {
    const pool = poolReturning([[{ id: 77 }]]);
    const repo = createRepo(createDb(pool));
    const id = await repo.addSignal(5, {
      symbol: 'NVDA',
      band: 'BUY',
      conviction: 0.7,
      plan: { foo: 1 },
      entryPrice: 100,
      spyEntryPrice: 400,
      qqqEntryPrice: 300,
      horizonDays: 5,
      resolveAfter: '2026-06-09T00:00:00Z',
    });
    expect(id).toBe(77);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('insert into legion.signals');
    expect(text.toLowerCase()).toContain('spy_entry_price');
    expect(text.toLowerCase()).toContain('returning id');
    expect(params).toContain(100);
    expect(params).toContain(400);
    expect(params).toContain(300);
    expect(params).toContain('2026-06-09T00:00:00Z');
  });

  it('addSignal defaults benchmark entry prices to null when omitted', async () => {
    const pool = poolReturning([[{ id: 78 }]]);
    const repo = createRepo(createDb(pool));
    await repo.addSignal(5, { symbol: 'NVDA', band: 'BUY', conviction: 0.7, plan: {} });
    expect(pool.calls[0].params).toEqual([
      5,
      'NVDA',
      'BUY',
      0.7,
      '{}',
      null,
      null,
      null,
      5,
      null,
      null,
    ]);
  });

  it('addSignalVotes bulk-inserts a snapshot row per vote with model', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.addSignalVotes(77, [
      { agentId: 'technical', stance: 1, conviction: 0.8, weight: 1.0, model: 'qwen2.5:7b-instruct' },
      { agentId: 'news', stance: -1, conviction: 0.5, weight: 1.2, model: null },
    ]);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('insert into legion.signal_votes');
    expect(params).toHaveLength(12);
    expect(params.slice(0, 6)).toEqual([77, 'technical', 1, 0.8, 1.0, 'qwen2.5:7b-instruct']);
    expect(params[11]).toBe('qwen2.5:7b-instruct'); // null model defaults to oracle
  });

  it('addSignalVotes is a no-op on empty votes', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.addSignalVotes(77, []);
    expect(pool.calls).toHaveLength(0);
  });

  it('listUnresolvedSignals filters by resolve_after <= now', async () => {
    const pool = poolReturning([[{ id: 1, symbol: 'NVDA', created_at: 'T0', entry_price: 100 }]]);
    const repo = createRepo(createDb(pool));
    const out = await repo.listUnresolvedSignals('2026-06-10T00:00:00Z');
    expect(out).toHaveLength(1);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('resolved = false');
    expect(text.toLowerCase()).toContain('resolve_after <=');
    expect(params).toEqual(['2026-06-10T00:00:00Z']);
  });

  it('resolveSignal writes returns + outcome and flips resolved', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.resolveSignal(1, {
      forwardReturn: 0.05,
      spyReturn: 0.02,
      qqqReturn: 0.03,
      outcome: 1,
      correct: true,
    });
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('update legion.signals');
    expect(text.toLowerCase()).toContain('resolved = true');
    expect(params).toEqual([0.05, 0.02, 0.03, 1, true, 1]);
  });

  it('getResolvedForecasts joins signal_votes to resolved signals', async () => {
    const pool = poolReturning([
      [
        { agent_id: 'technical', stance: 1, conviction: 0.8, outcome: 1 },
        { agent_id: 'technical', stance: -1, conviction: 0.5, outcome: 0 },
      ],
    ]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.getResolvedForecasts(50);
    expect(rows).toHaveLength(2);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('from legion.signal_votes');
    expect(text.toLowerCase()).toContain('join legion.signals');
    expect(text.toLowerCase()).toContain('s.resolved = true');
    expect(params).toEqual([50]);
  });

  it('recordBacktestResult inserts a row', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.recordBacktestResult({
      symbol: 'NVDA',
      horizon: 5,
      trades: 10,
      hits: 6,
      hitRate: 0.6,
      pnl: 0.12,
      spyPnl: 0.05,
      qqqPnl: 0.07,
    });
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('insert into legion.backtest_results');
    expect(params).toEqual(['NVDA', 5, 10, 6, 0.6, 0.12, 0.05, 0.07]);
  });

  it('getReliabilityLeaderboard orders by rho desc and includes model', async () => {
    const pool = poolReturning([
      [{ agent_id: 'technical', model: 'qwen2.5:7b-instruct', rho: 1.4, sample_size: 20 }],
    ]);
    const repo = createRepo(createDb(pool));
    const out = await repo.getReliabilityLeaderboard();
    expect(out).toEqual([
      { agentId: 'technical', model: 'qwen2.5:7b-instruct', rho: 1.4, sampleSize: 20 },
    ]);
    expect(pool.calls[0].text.toLowerCase()).toContain('order by rho desc');
  });

  it('listBacktestResults filters by symbol when given', async () => {
    const pool = poolReturning([[{ id: 1, symbol: 'NVDA', hit_rate: 0.6 }]]);
    const repo = createRepo(createDb(pool));
    await repo.listBacktestResults('NVDA', 20);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('where symbol =');
    expect(params).toEqual(['NVDA', 20]);
  });

  it('getSignalStance derives ordinal direction from the signal band', async () => {
    const pool = poolReturning([[{ band: 'STRONG_BUY' }], [{ band: 'NO_CONSENSUS' }]]);
    const repo = createRepo(createDb(pool));
    expect(await repo.getSignalStance(1)).toBe(2);
    expect(await repo.getSignalStance(2)).toBe(0);
  });
});

describe('getAgentTrackRecord (ADR 0025)', () => {
  it('returns the overall directional hit count and recent same-symbol calls', async () => {
    const pool = poolReturning([
      [{ total: 6, hits: 4 }],
      [
        {
          symbol: 'NVDA',
          stance: 1,
          conviction: 0.8,
          outcome: 1,
          forward_return: 0.04,
          spy_return: 0.01,
        },
      ],
    ]);
    const repo = createRepo(createDb(pool));
    const record = await repo.getAgentTrackRecord('technical', 'NVDA');
    expect(record.overall).toEqual({ hits: 4, total: 6 });
    expect(record.recent).toHaveLength(1);
    const texts = pool.calls.map((c) => c.text.toLowerCase());
    expect(texts[0]).toContain('stance <> 0');
    expect(texts[1]).toContain('s.symbol = $2');
    expect(pool.calls[1].params).toEqual(['technical', 'NVDA', 3]);
  });

  it('reports a zero record when nothing has resolved', async () => {
    const pool = poolReturning([[], []]);
    const repo = createRepo(createDb(pool));
    const record = await repo.getAgentTrackRecord('news', 'MU');
    expect(record.overall).toEqual({ hits: 0, total: 0 });
    expect(record.recent).toEqual([]);
  });
});

describe('agent lessons (ADR 0026)', () => {
  it('getAgentMisses selects only directional misses, newest first', async () => {
    const rows = [{ symbol: 'NVDA', stance: 2, conviction: 0.9, outcome: 0 }];
    const pool = poolReturning([rows]);
    const repo = createRepo(createDb(pool));
    const out = await repo.getAgentMisses('technical', 10);
    expect(out).toEqual(rows);
    const text = pool.calls[0].text.toLowerCase();
    expect(text).toContain('stance <> 0');
    expect(text).toContain('sv.stance > 0 and s.outcome = 0');
    expect(pool.calls[0].params).toEqual(['technical', 10]);
  });

  it('upsertAgentLesson and getAgentLesson round-trip', async () => {
    const pool = poolReturning([[], [{ lesson: 'Avoid chasing momentum.' }], []]);
    const repo = createRepo(createDb(pool));
    await repo.upsertAgentLesson('technical', 'Avoid chasing momentum.', 4);
    expect(pool.calls[0].text.toLowerCase()).toContain('legion.agent_lessons');
    expect(pool.calls[0].params).toEqual(['technical', 'Avoid chasing momentum.', 4]);
    expect(await repo.getAgentLesson('technical')).toBe('Avoid chasing momentum.');
    expect(await repo.getAgentLesson('news')).toBeNull();
  });
});

describe('learned prior (ADR 0027)', () => {
  it('upsertLearnedPrior writes the long-window prior keyed by model', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.upsertLearnedPrior('news', 'qwen2.5:7b-instruct', 1.15);
    expect(pool.calls[0].text.toLowerCase()).toContain('learned_prior');
    expect(pool.calls[0].params).toEqual(['news', 'qwen2.5:7b-instruct', 1.15]);
  });

  it('leaderboard surfaces every learned dial including model', async () => {
    const pool = poolReturning([
      [
        {
          agent_id: 'technical',
          model: 'qwen2.5:7b-instruct',
          rho: 1.2,
          sample_size: 30,
          calibration: 1.1,
          info_factor: 1.0,
          learned_prior: 1.15,
          floored_streak: 0,
          flagged: false,
        },
      ],
    ]);
    const repo = createRepo(createDb(pool));
    expect(await repo.getReliabilityLeaderboard()).toEqual([
      {
        agentId: 'technical',
        model: 'qwen2.5:7b-instruct',
        rho: 1.2,
        sampleSize: 30,
        calibration: 1.1,
        infoFactor: 1.0,
        learnedPrior: 1.15,
        flooredStreak: 0,
        flagged: false,
      },
    ]);
  });
});

describe('roster watch repo (ADR 0028)', () => {
  it('reads floored streaks as nested map and writes the flag keyed by model', async () => {
    const pool = poolReturning([
      [{ agent_id: 'social', model: 'qwen2.5:7b-instruct', floored_streak: 5 }],
      [],
    ]);
    const repo = createRepo(createDb(pool));
    expect(await repo.getFlooredStreaks()).toEqual({ social: { 'qwen2.5:7b-instruct': 5 } });
    await repo.updateRosterFlag('social', 'qwen2.5:7b-instruct', 6, true);
    expect(pool.calls[1].text.toLowerCase()).toContain('floored_streak');
    expect(pool.calls[1].params).toEqual(['social', 'qwen2.5:7b-instruct', 6, true]);
  });
});

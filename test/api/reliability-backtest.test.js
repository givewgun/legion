import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub(overrides = {}) {
  return {
    getReliabilityLeaderboard: async () => [
      {
        agentId: 'technical',
        rho: 1.4,
        sampleSize: 20,
        calibration: 1.1,
        infoFactor: 0.9,
        learnedPrior: 1.3,
        flagged: false,
        flooredStreak: 0,
      },
      {
        agentId: 'news',
        rho: 0.8,
        sampleSize: 15,
        calibration: 0.9,
        infoFactor: 1.0,
        learnedPrior: 0.85,
        flagged: false,
        flooredStreak: 0,
      },
    ],
    getAgentBoardRows: async () => [],
    listBacktestResults: async (symbol, limit) => [
      { id: 1, symbol: symbol ?? 'NVDA', hit_rate: 0.6, pnl: 0.12, _limit: limit },
    ],
    ...overrides,
  };
}

describe('GET /api/reliability', () => {
  it('returns the leaderboard (backward compatible)', async () => {
    const res = await request(createApp({ repo: repoStub() })).get('/api/reliability');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].agentId).toBe('technical');
  });

  it('returns the enriched v2 shape with performance fields', async () => {
    const boardRows = [
      {
        agent_id: 'technical',
        id: 10,
        symbol: 'NVDA',
        stance: 1,
        conviction: 0.8,
        outcome: 1,
        forward_return: 0.06,
        spy_return: 0.01,
      },
      {
        agent_id: 'technical',
        id: 9,
        symbol: 'AAPL',
        stance: 1,
        conviction: 0.7,
        outcome: 0,
        forward_return: -0.02,
        spy_return: 0.01,
      },
      {
        agent_id: 'technical',
        id: 8,
        symbol: 'MU',
        stance: 0,
        conviction: 0.5,
        outcome: 1,
        forward_return: null,
        spy_return: null,
      },
    ];
    const res = await request(
      createApp({ repo: repoStub({ getAgentBoardRows: async () => boardRows }) }),
    ).get('/api/reliability');
    expect(res.status).toBe(200);
    const technical = res.body.find((a) => a.agentId === 'technical');
    expect(technical.wins).toBe(1);
    expect(technical.losses).toBe(1);
    expect(technical.holds).toBe(1);
    expect(technical.hitRate).toBeCloseTo(0.5);
    // alpha on win: 0.06-0.01=0.05; on loss: -0.02-0.01=-0.03 → avg 0.01
    expect(technical.avgAlpha).toBeCloseTo(0.01);
    expect(technical.bestAlpha).toBeCloseTo(0.05);
    expect(technical.worstAlpha).toBeCloseTo(-0.03);
    expect(technical.recent).toHaveLength(3);
    expect(technical.recent[0].symbol).toBe('NVDA');
  });

  it('agent with no board rows gets zeroed counts and null magnitudes', async () => {
    const res = await request(createApp({ repo: repoStub() })).get('/api/reliability');
    const news = res.body.find((a) => a.agentId === 'news');
    expect(news.wins).toBe(0);
    expect(news.losses).toBe(0);
    expect(news.holds).toBe(0);
    expect(news.hitRate).toBeNull();
    expect(news.avgAlpha).toBeNull();
    expect(news.bestAlpha).toBeNull();
    expect(news.worstAlpha).toBeNull();
    expect(news.recent).toEqual([]);
  });

  it('result is ordered by rho desc (leaderboard order preserved)', async () => {
    const res = await request(createApp({ repo: repoStub() })).get('/api/reliability');
    expect(res.body[0].rho).toBeGreaterThan(res.body[1].rho);
  });

  it('preserves all existing dial fields (backward compatible)', async () => {
    const res = await request(createApp({ repo: repoStub() })).get('/api/reliability');
    const agent = res.body[0];
    expect(agent).toMatchObject({
      agentId: 'technical',
      rho: 1.4,
      sampleSize: 20,
      calibration: 1.1,
      infoFactor: 0.9,
      learnedPrior: 1.3,
      flagged: false,
      flooredStreak: 0,
    });
  });
});

describe('GET /api/backtest', () => {
  it('returns all results when no symbol given', async () => {
    const res = await request(createApp({ repo: repoStub() })).get('/api/backtest');
    expect(res.status).toBe(200);
    expect(res.body[0]._limit).toBe(50);
  });
  it('passes the symbol filter through', async () => {
    const res = await request(createApp({ repo: repoStub() })).get('/api/backtest?symbol=MU');
    expect(res.status).toBe(200);
    expect(res.body[0].symbol).toBe('MU');
  });
});

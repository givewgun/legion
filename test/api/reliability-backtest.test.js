import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub() {
  return {
    getReliabilityLeaderboard: async () => [
      { agentId: 'technical', rho: 1.4, sampleSize: 20 },
      { agentId: 'news', rho: 0.8, sampleSize: 15 },
    ],
    listBacktestResults: async (symbol, limit) => [
      { id: 1, symbol: symbol ?? 'NVDA', hit_rate: 0.6, pnl: 0.12, _limit: limit },
    ],
  };
}

describe('GET /api/reliability', () => {
  it('returns the leaderboard', async () => {
    const res = await request(createApp({ repo: repoStub() })).get('/api/reliability');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].agentId).toBe('technical');
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

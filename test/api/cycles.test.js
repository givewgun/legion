import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub(overrides = {}) {
  return {
    listTickers: vi.fn(async () => []),
    listTickersWithCycles: vi.fn(async () => [
      {
        symbol: 'NVDA',
        latest_cycle_id: 9,
        latest_status: 'converged',
        latest_started_at: 't',
        cycle_count: 2,
      },
    ]),
    listCycles: vi.fn(async () => [{ id: 9, symbol: 'NVDA', status: 'converged' }]),
    getCycle: vi.fn(async () => ({ id: 9, symbol: 'NVDA', status: 'converged' })),
    getRounds: vi.fn(async () => [
      { id: 1, round_no: 1, s_score: 1.6, dispersion: 0.1, quorum: 0.9, converged: true },
    ]),
    getVotes: vi.fn(async () => [
      { agent_id: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'up' },
    ]),
    ...overrides,
  };
}

describe('cycle routes', () => {
  it('GET /api/cycles?symbol=NVDA lists recent cycles', async () => {
    const repo = repoStub();
    const app = createApp({ repo });
    const res = await request(app).get('/api/cycles?symbol=nvda');
    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe(9);
    expect(repo.listCycles).toHaveBeenCalledWith('nvda', 20);
  });

  it('GET /api/cycles/tickers lists symbols that have cycles', async () => {
    const repo = repoStub();
    const app = createApp({ repo });
    const res = await request(app).get('/api/cycles/tickers');
    expect(res.status).toBe(200);
    expect(res.body[0].symbol).toBe('NVDA');
    expect(res.body[0].cycle_count).toBe(2);
    expect(repo.listTickersWithCycles).toHaveBeenCalled();
  });

  it('GET /api/cycles requires a symbol', async () => {
    const app = createApp({ repo: repoStub() });
    const res = await request(app).get('/api/cycles');
    expect(res.status).toBe(400);
  });

  it('GET /api/cycles/:id returns the debate tree', async () => {
    const app = createApp({ repo: repoStub() });
    const res = await request(app).get('/api/cycles/9');
    expect(res.status).toBe(200);
    expect(res.body.rounds[0].votes[0].agent_id).toBe('technical');
  });

  it('GET /api/cycles/:id 404s an unknown cycle', async () => {
    const app = createApp({ repo: repoStub({ getCycle: vi.fn(async () => null) }) });
    const res = await request(app).get('/api/cycles/999');
    expect(res.status).toBe(404);
  });

  it('GET /api/cycles/:id 400s a non-numeric id', async () => {
    const app = createApp({ repo: repoStub() });
    const res = await request(app).get('/api/cycles/abc');
    expect(res.status).toBe(400);
  });
});

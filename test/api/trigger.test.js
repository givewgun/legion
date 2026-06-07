import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub(overrides = {}) {
  return {
    listEnabledTickers: vi.fn(async () => ['NVDA', 'MU']),
    ...overrides,
  };
}

function orchestratorStub(overrides = {}) {
  return {
    kick: vi.fn(async (symbol) => `cycle-${symbol}`),
    ...overrides,
  };
}

describe('trigger routes', () => {
  it('POST /api/trigger/:symbol kicks one ticker and returns its cycle id', async () => {
    const orchestrator = orchestratorStub();
    const app = createApp({ repo: repoStub(), orchestrator });
    const res = await request(app).post('/api/trigger/nvda');
    expect(res.status).toBe(202);
    expect(orchestrator.kick).toHaveBeenCalledWith('NVDA');
    expect(res.body).toEqual({ symbol: 'NVDA', cycleId: 'cycle-NVDA' });
  });

  it('POST /api/trigger sweeps every enabled ticker', async () => {
    const orchestrator = orchestratorStub();
    const repo = repoStub();
    const app = createApp({ repo, orchestrator });
    const res = await request(app).post('/api/trigger');
    expect(res.status).toBe(202);
    expect(repo.listEnabledTickers).toHaveBeenCalled();
    expect(orchestrator.kick).toHaveBeenCalledTimes(2);
    expect(res.body.kicked).toEqual([
      { symbol: 'NVDA', cycleId: 'cycle-NVDA' },
      { symbol: 'MU', cycleId: 'cycle-MU' },
    ]);
  });

  it('POST /api/trigger returns 503 when the bus/orchestrator is not wired', async () => {
    const app = createApp({ repo: repoStub() }); // no orchestrator (data-only mode)
    const res = await request(app).post('/api/trigger');
    expect(res.status).toBe(503);
  });

  it('POST /api/trigger/:symbol returns 503 without an orchestrator', async () => {
    const app = createApp({ repo: repoStub() });
    const res = await request(app).post('/api/trigger/NVDA');
    expect(res.status).toBe(503);
  });

  it('surfaces a kick failure as a 500 with the error message', async () => {
    const orchestrator = orchestratorStub({
      kick: vi.fn(async () => {
        throw new Error('ticker not seeded');
      }),
    });
    const app = createApp({ repo: repoStub(), orchestrator });
    const res = await request(app).post('/api/trigger/ZZZ');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ticker not seeded/);
  });
});

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub(overrides = {}) {
  return {
    listTickers: vi.fn(async () => []),
    listSignals: vi.fn(async () => [
      { id: 3, symbol: 'NVDA', band: 'STRONG_BUY', conviction: 0.9, plan: {} },
    ]),
    ...overrides,
  };
}

describe('signal routes', () => {
  it('GET /api/signals lists across all symbols', async () => {
    const repo = repoStub();
    const app = createApp({ repo });
    const res = await request(app).get('/api/signals');
    expect(res.status).toBe(200);
    expect(res.body[0].band).toBe('STRONG_BUY');
    expect(repo.listSignals).toHaveBeenCalledWith(null, 50);
  });

  it('GET /api/signals?symbol=MU filters by symbol', async () => {
    const repo = repoStub();
    const app = createApp({ repo });
    await request(app).get('/api/signals?symbol=mu');
    expect(repo.listSignals).toHaveBeenCalledWith('mu', 50);
  });
});

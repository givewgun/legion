import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { holdingsRoutes } from '../../src/api/routes/holdings.js';

function appWith(repo, gunvest, quality) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 7 }; next(); });
  app.use('/api/holdings', holdingsRoutes(repo, gunvest, quality));
  return app;
}

describe('holdings routes', () => {
  const baseRepo = {
    holdings: [{ ticker: 'NVDA', shares: 10, avgCost: 80 }],
    async listHoldings() { return this.holdings; },
    async upsertHolding(_u, h) { this.holdings = [{ ticker: h.ticker.toUpperCase(), shares: h.shares, avgCost: h.avgCost }]; return this.holdings[0]; },
    async deleteHolding() { this.holdings = []; return true; },
    async listAllSignals() { return [{ symbol: 'NVDA', band: 'BUY', conviction: 1, plan: { qualityMult: 1.2 } }]; },
  };
  const gunvest = { getPrice: async () => ({ price: 100 }) };
  const quality = { getQuality: async () => ({ qualityMult: 1.2, flags: [] }) };

  it('lists holdings', async () => {
    const res = await request(appWith(baseRepo, gunvest, quality)).get('/api/holdings');
    expect(res.status).toBe(200);
    expect(res.body.holdings[0].ticker).toBe('NVDA');
  });

  it('upserts a holding', async () => {
    const repo = { ...baseRepo, holdings: [...baseRepo.holdings] };
    const res = await request(appWith(repo, gunvest, quality)).put('/api/holdings/amd').send({ shares: 5, avgCost: 100 });
    expect(res.status).toBe(201);
  });

  it('returns a sizing book', async () => {
    const res = await request(appWith(baseRepo, gunvest, quality)).get('/api/holdings/sizing');
    expect(res.status).toBe(200);
    expect(res.body.rows[0].ticker).toBe('NVDA');
    expect(res.body.summary.totalValue).toBe(1000);
  });
});

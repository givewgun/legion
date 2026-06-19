import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { watchlistRoutes } from '../../src/api/routes/watchlist.js';

function build(repo) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); }); // inject auth
  app.use('/api/watchlist', watchlistRoutes(repo));
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

function repoStub(overrides = {}) {
  return {
    listWatchlist: vi.fn(async () => ['NVDA']),
    addWatchlistSymbol: vi.fn(async () => {}),
    removeWatchlistSymbol: vi.fn(async () => {}),
    listTickers: vi.fn(async () => [{ symbol: 'NVDA', enabled: true }, { symbol: 'AMD', enabled: true }]),
    ...overrides,
  };
}

describe('watchlist routes', () => {
  it('GET / returns the user symbols', async () => {
    const res = await request(build(repoStub())).get('/api/watchlist');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ symbols: ['NVDA'] });
  });

  it('PUT /:symbol adds a roster symbol and returns the updated list', async () => {
    const repo = repoStub({ listWatchlist: vi.fn(async () => ['NVDA', 'AMD']) });
    const res = await request(build(repo)).put('/api/watchlist/amd');
    expect(res.status).toBe(201);
    expect(repo.addWatchlistSymbol).toHaveBeenCalledWith(1, 'amd');
    expect(res.body).toEqual({ symbols: ['NVDA', 'AMD'] });
  });

  it('PUT /:symbol 404s a symbol not on the global roster', async () => {
    const repo = repoStub();
    const res = await request(build(repo)).put('/api/watchlist/ZZZZ');
    expect(res.status).toBe(404);
    expect(repo.addWatchlistSymbol).not.toHaveBeenCalled();
  });

  it('DELETE /:symbol removes and returns the updated list', async () => {
    const repo = repoStub({ listWatchlist: vi.fn(async () => []) });
    const res = await request(build(repo)).delete('/api/watchlist/NVDA');
    expect(res.status).toBe(200);
    expect(repo.removeWatchlistSymbol).toHaveBeenCalledWith(1, 'NVDA');
    expect(res.body).toEqual({ symbols: [] });
  });
});

import { describe, it, expect, vi } from 'vitest';
import session from 'express-session';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub() {
  const user = { id: 1, email: 'a@b.com', name: 'A', avatarUrl: null };
  return {
    upsertUser: vi.fn(async () => user),
    getUserById: vi.fn(async (id) => (id === 1 ? user : null)),
    listTickers: vi.fn(async () => [{ symbol: 'NVDA', enabled: true }]),
  };
}

function authStub(repo, { allowedEmails = ['a@b.com'] } = {}) {
  return {
    // MemoryStore session — fine for a single test process.
    session: session({ secret: 't', resave: false, saveUninitialized: false }),
    google: {
      authUrl: (state) => `https://accounts.google.com/x?state=${state}`,
      exchange: vi.fn(async () => ({ googleSub: 'g', email: 'a@b.com', name: 'A', avatarUrl: null })),
    },
    allowedEmails,
    repo,
  };
}

describe('createApp with auth', () => {
  it('gates shared routes with 401 when unauthenticated', async () => {
    const repo = repoStub();
    const app = createApp({ repo, auth: authStub(repo) });
    const res = await request(app).get('/api/tickers');
    expect(res.status).toBe(401);
  });

  it('leaves /health open', async () => {
    const repo = repoStub();
    const app = createApp({ repo, auth: authStub(repo) });
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('completes the login flow and then serves gated routes', async () => {
    const repo = repoStub();
    const app = createApp({ repo, auth: authStub(repo) });
    const agent = request.agent(app);

    // 1. Start login to seed session state.
    const start = await agent.get('/api/auth/google');
    const state = new URL(start.headers.location).searchParams.get('state');

    // 2. Callback with the matching state → session established, redirect to /.
    const cb = await agent.get(`/api/auth/google/callback?code=c&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/');

    // 3. Gated route now succeeds for the same agent (cookie carried).
    const tickers = await agent.get('/api/tickers');
    expect(tickers.status).toBe(200);
    expect(tickers.body).toEqual([{ symbol: 'NVDA', enabled: true }]);
  });
});

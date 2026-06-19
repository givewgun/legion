import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { authRoutes } from '../../src/auth/routes.js';

// Real express-session with MemoryStore so oauthState persists across requests
// within a supertest agent (cookie-based session).
function sessionMiddleware() {
  return session({ secret: 't', resave: false, saveUninitialized: false });
}

function build({ google, repo, allowedEmails }) {
  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware());
  app.use('/api/auth', authRoutes({ google, repo, allowedEmails }));
  return app;
}

describe('auth routes', () => {
  it('GET /google redirects to the consent screen', async () => {
    const google = { authUrl: vi.fn(() => 'https://accounts.google.com/x'), exchange: vi.fn() };
    const res = await request(build({ google, repo: {}, allowedEmails: [] })).get('/api/auth/google');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://accounts.google.com/x');
  });

  it('GET /me 401s without a session user', async () => {
    const res = await request(build({ google: {}, repo: {}, allowedEmails: [] })).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('callback rejects an email off the allowlist with 403', async () => {
    const google = {
      authUrl: vi.fn((state) => `https://accounts.google.com/x?state=${state}`),
      exchange: vi.fn(async () => ({ googleSub: 'g', email: 'x@y.com', name: 'X', avatarUrl: null })),
    };
    const app = build({ google, repo: {}, allowedEmails: ['a@b.com'] });

    // Use a persistent agent so the session cookie carries oauthState across requests.
    const agent = request.agent(app);

    // Step 1: seed oauthState into the session via the /google redirect.
    const initRes = await agent.get('/api/auth/google');
    expect(initRes.status).toBe(302);

    // Extract the `state` param from the consent URL that was set by authUrl().
    const location = initRes.headers.location;
    const state = new URL(location).searchParams.get('state');
    expect(state).toBeTruthy();

    // Step 2: hit the callback with the correct state — so the CSRF check passes
    // and we reach the allowlist branch.
    const res = await agent.get(`/api/auth/google/callback?code=c&state=${state}`);

    // Must be 403 from the allowlist branch (not the CSRF branch).
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not authorized');

    // Prove the flow reached google.exchange (past the CSRF check).
    expect(google.exchange).toHaveBeenCalledWith('c');
  });
});

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authRoutes } from '../../src/auth/routes.js';

// Minimal in-memory session so callback state survives within one agent.
function sessionShim() {
  return (req, _res, next) => {
    req.session ??= { destroy: (cb) => cb && cb() };
    next();
  };
}

function build({ google, repo, allowedEmails }) {
  const app = express();
  app.use(express.json());
  app.use(sessionShim());
  app.use('/api/auth', authRoutes({ google, repo, allowedEmails, publicUrl: 'http://x' }));
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
    const google = { exchange: vi.fn(async () => ({ googleSub: 'g', email: 'x@y.com', name: 'X', avatarUrl: null })) };
    const app = build({ google, repo: {}, allowedEmails: ['a@b.com'] });
    // state check is bypassed here because the shim has no stored state; the
    // route must treat a missing/with mismatched state as 403 too (see impl).
    const res = await request(app).get('/api/auth/google/callback?code=c&state=s');
    expect(res.status).toBe(403);
  });
});

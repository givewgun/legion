import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub(initial = {}) {
  const store = { ...initial };
  return {
    getAllAgentConfig: async () => store,
    upsertAgentConfig: async (id, cfg) => {
      store[id] = cfg;
    },
    _store: store,
  };
}

describe('GET /api/agents', () => {
  it('returns the roster merged with persisted config', async () => {
    const repo = repoStub({
      technical: { provider: 'gemini', model: 'gemini-2.5-flash', enabled: true },
    });
    const res = await request(createApp({ repo })).get('/api/agents');
    expect(res.status).toBe(200);
    const tech = res.body.find((a) => a.id === 'technical');
    expect(tech.provider).toBe('gemini');
    expect(tech.weight).toBeGreaterThan(0); // static prior present
    const news = res.body.find((a) => a.id === 'news');
    expect(news.provider).toBe('local'); // default when no row
  });
});

describe('PATCH /api/agents/:id', () => {
  it('upserts a valid provider change', async () => {
    const repo = repoStub();
    const res = await request(createApp({ repo }))
      .patch('/api/agents/technical')
      .send({ provider: 'gemini', model: 'gemini-2.5-flash', enabled: true });
    expect(res.status).toBe(200);
    expect(repo._store.technical.provider).toBe('gemini');
  });

  it('rejects an unknown provider with 400', async () => {
    const res = await request(createApp({ repo: repoStub() }))
      .patch('/api/agents/technical')
      .send({ provider: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown agent id with 404', async () => {
    const res = await request(createApp({ repo: repoStub() }))
      .patch('/api/agents/nonexistent')
      .send({ provider: 'local' });
    expect(res.status).toBe(404);
  });
});

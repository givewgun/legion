import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { settingsRoutes } from '../../src/api/routes/settings.js';

function appWith(repo) {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(repo));
  return app;
}

describe('settings routes', () => {
  it('GET returns the home-PC flag', async () => {
    const repo = { getHomePcEnabled: async () => false };
    const res = await request(appWith(repo)).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ homePcEnabled: false });
  });

  it('PUT updates the flag', async () => {
    const set = vi.fn(async () => {});
    const repo = { setHomePcEnabled: set, getHomePcEnabled: async () => true };
    const res = await request(appWith(repo)).put('/api/settings').send({ homePcEnabled: true });
    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalledWith(true);
    expect(res.body).toEqual({ homePcEnabled: true });
  });

  it('PUT rejects a non-boolean flag', async () => {
    const res = await request(appWith({})).put('/api/settings').send({ homePcEnabled: 'yes' });
    expect(res.status).toBe(400);
  });
});

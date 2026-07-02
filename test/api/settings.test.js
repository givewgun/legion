import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { settingsRoutes } from '../../src/api/routes/settings.js';

const CFG = {
  home: { url: 'http://pc:11435', model: 'qwen3:14b', fallback: true, enabled: true, think: true, timeoutMs: 3600000, probeTimeoutMs: 1500 },
  ollama: { url: 'http://oracle:11434', model: 'qwen2.5:7b-instruct' },
};

function appWith(repo, fetchImpl) {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(repo, CFG, fetchImpl));
  return app;
}

describe('settings routes', () => {
  it('GET reports each key with effective value, source, and env default', async () => {
    const repo = { getRuntimeConfig: async () => ({ home_model: 'qwen3:8b' }) };
    const res = await request(appWith(repo)).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.settings.home_model).toMatchObject({
      value: 'qwen3:8b',
      source: 'db',
      default: 'qwen3:14b',
    });
    // a key with no row falls back to the env default
    expect(res.body.settings.oracle_model).toMatchObject({
      value: 'qwen2.5:7b-instruct',
      source: 'default',
    });
  });

  it('GET reports source=default when a stored row fails coercion (falls back to env)', async () => {
    const repo = { getRuntimeConfig: async () => ({ home_fallback: 'not-a-bool' }) };
    const res = await request(appWith(repo)).get('/api/settings');
    expect(res.body.settings.home_fallback).toMatchObject({ value: true, source: 'default' });
  });

  it('PUT upserts a valid override and returns the new effective settings', async () => {
    const set = vi.fn(async () => {});
    const store = { home_model: 'qwen3:8b' };
    const repo = { setRuntimeConfig: set, deleteRuntimeConfig: vi.fn(), getRuntimeConfig: async () => store };
    const res = await request(appWith(repo)).put('/api/settings').send({ home_model: 'qwen3:8b' });
    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalledWith('home_model', 'qwen3:8b');
    expect(res.body.settings.home_model.value).toBe('qwen3:8b');
  });

  it('PUT with null resets a key (delete row)', async () => {
    const del = vi.fn(async () => {});
    const repo = { setRuntimeConfig: vi.fn(), deleteRuntimeConfig: del, getRuntimeConfig: async () => ({}) };
    const res = await request(appWith(repo)).put('/api/settings').send({ home_model: null });
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalledWith('home_model');
  });

  it('PUT rejects an unknown key', async () => {
    const res = await request(appWith({})).put('/api/settings').send({ bogus: 'x' });
    expect(res.status).toBe(400);
  });

  it('PUT rejects a type-invalid value', async () => {
    const res = await request(appWith({})).put('/api/settings').send({ home_fallback: 'yes' });
    expect(res.status).toBe(400);
  });

  it('GET /pc-models proxies the sidecar tags', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen3:8b' }, { name: 'qwen3:14b' }] }),
    }));
    const res = await request(appWith({}, fetchImpl)).get('/api/settings/pc-models');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: ['qwen3:8b', 'qwen3:14b'] });
  });

  it('GET /pc-models fails soft to an empty list when the PC is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await request(appWith({}, fetchImpl)).get('/api/settings/pc-models');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: [] });
  });

  it("GET /oracle-models proxies the Oracle box's tags", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen3:4b' }, { name: 'qwen2.5:7b-instruct' }] }),
    }));
    const res = await request(appWith({}, fetchImpl)).get('/api/settings/oracle-models');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: ['qwen3:4b', 'qwen2.5:7b-instruct'] });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://oracle:11434/api/tags');
  });

  it('GET /oracle-models fails soft to an empty list when the box is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await request(appWith({}, fetchImpl)).get('/api/settings/oracle-models');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: [] });
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRepo } from '../../src/db/repo.js';
import { createDb } from '../../src/db/client.js';

const schema = readFileSync(
  fileURLToPath(new URL('../../src/db/schema.sql', import.meta.url)),
  'utf8',
).toLowerCase();

function poolReturning(rows) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows };
    },
  };
}

describe('phase5 schema', () => {
  it('creates legion.agent_config with provider, model, enabled', () => {
    expect(schema).toContain('create table if not exists legion.agent_config');
    expect(schema).toContain('provider');
    expect(schema).toContain('model');
    expect(schema).toContain('enabled');
  });
});

describe('agent_config repo', () => {
  it('getAllAgentConfig maps rows to a keyed object', async () => {
    const pool = poolReturning([
      { agent_id: 'technical', provider: 'local', model: 'qwen2.5:7b', enabled: true },
      { agent_id: 'news', provider: 'gemini', model: 'gemini-2.5-flash', enabled: true },
    ]);
    const repo = createRepo(createDb(pool));
    const cfg = await repo.getAllAgentConfig();
    expect(cfg.technical).toEqual({ provider: 'local', model: 'qwen2.5:7b', enabled: true });
    expect(cfg.news.provider).toBe('gemini');
  });

  it('getAgentConfig returns one row or null', async () => {
    const repo = createRepo(
      createDb(poolReturning([{ agent_id: 'technical', provider: 'local', model: 'm', enabled: true }])),
    );
    const cfg = await repo.getAgentConfig('technical');
    expect(cfg).toEqual({ provider: 'local', model: 'm', enabled: true });
    const repo2 = createRepo(createDb(poolReturning([])));
    expect(await repo2.getAgentConfig('missing')).toBeNull();
  });

  it('upsertAgentConfig upserts provider/model/enabled', async () => {
    const pool = poolReturning([]);
    const repo = createRepo(createDb(pool));
    await repo.upsertAgentConfig('technical', {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      enabled: false,
    });
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('insert into legion.agent_config');
    expect(text.toLowerCase()).toContain('on conflict');
    expect(params).toEqual(['technical', 'gemini', 'gemini-2.5-flash', false]);
  });
});

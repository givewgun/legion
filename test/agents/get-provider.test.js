import { describe, it, expect } from 'vitest';
import { buildGetProvider } from '../../src/agents/get-provider.js';

function repoStub(map, runtimeConfig = {}) {
  return {
    getAgentConfig: async (id) => map[id] ?? null,
    getRuntimeConfig: async () => runtimeConfig,
  };
}

describe('buildGetProvider', () => {
  it('builds the default provider (not null) when the agent has no persisted row', async () => {
    // No per-agent row must still produce a provider so the GLOBAL runtime overrides
    // apply; the model is left to cfg (null = no per-agent override).
    const calls = [];
    const factory = (opts) => {
      calls.push(opts);
      return { generate: async () => '' };
    };
    const getProvider = buildGetProvider({
      repo: repoStub({}),
      cfg: {},
      factory,
      defaultProvider: 'local',
    });
    const out = await getProvider({ agentId: 'technical' });
    expect(out).toEqual({ provider: { generate: expect.any(Function) }, enabled: true });
    expect(calls[0]).toEqual({ type: 'local', model: null });
  });

  it('resolves the persisted provider/model and reports enabled', async () => {
    const calls = [];
    const sentinel = { generate: async () => '' };
    const factory = (opts) => {
      calls.push(opts);
      return sentinel;
    };
    const repo = repoStub({ technical: { provider: 'local', model: 'qwen2.5:14b', enabled: true } });
    const getProvider = buildGetProvider({ repo, cfg: {}, factory });
    const out = await getProvider({ agentId: 'technical' });
    expect(calls[0]).toEqual({ type: 'local', model: 'qwen2.5:14b' });
    expect(out).toEqual({ provider: sentinel, enabled: true });
  });

  it('passes a null model through when the row has none (cfg supplies the model)', async () => {
    const calls = [];
    const factory = (opts) => {
      calls.push(opts);
      return { generate: async () => '' };
    };
    const repo = repoStub({ news: { provider: 'local', model: null, enabled: true } });
    const getProvider = buildGetProvider({ repo, cfg: {}, factory });
    await getProvider({ agentId: 'news' });
    expect(calls[0]).toEqual({ type: 'local', model: null });
  });

  it('short-circuits a disabled agent without constructing a provider', async () => {
    let built = false;
    const factory = () => {
      built = true;
      return { generate: async () => '' };
    };
    const repo = repoStub({ social: { provider: 'gemini', model: null, enabled: false } });
    const getProvider = buildGetProvider({ repo, cfg: {}, factory });
    const out = await getProvider({ agentId: 'social' });
    expect(out).toEqual({ enabled: false });
    expect(built).toBe(false);
  });

  it('disables the home tier when the global toggle is off', async () => {
    const receivedCfgs = [];
    const factory = (opts, cfg) => {
      receivedCfgs.push({ opts, cfg });
      return { name: opts.type, model: opts.model, generate: async () => 'x' };
    };
    const repo = {
      getAgentConfig: async () => ({ provider: 'local', model: null, enabled: true }),
      getRuntimeConfig: async () => ({ home_pc_enabled: 'false' }),
    };
    const cfg = { ollama: { url: 'o' }, home: { url: 'http://pc:11434', enabled: true, model: 'gpt-oss:20b' } };
    const getProvider = buildGetProvider({ repo, cfg, factory });
    await getProvider({ agentId: 'news' });
    expect(receivedCfgs).toHaveLength(1);
    expect(receivedCfgs[0].cfg.home.enabled).toBe(false);
  });

  it('applies global runtime overrides even when the agent has no per-agent row', async () => {
    // The whole point of runtime_config is global, no-redeploy knobs (fallback, model,
    // toggle). They must take effect for an agent that has never been saved on the
    // per-agent Agents tab — otherwise the static env-built provider is used and the
    // dashboard toggles are silently ignored.
    const receivedCfgs = [];
    const factory = (opts, cfg) => {
      receivedCfgs.push(cfg);
      return { name: opts.type, model: opts.model, generate: async () => 'x' };
    };
    const repo = {
      getAgentConfig: async () => null, // never saved a per-agent row
      getRuntimeConfig: async () => ({ home_fallback: 'true', home_model: 'qwen3:8b' }),
    };
    const cfg = {
      ollama: { url: 'o', model: 'oracle-m' },
      home: { url: 'http://pc:11434', enabled: true, fallback: false, model: 'qwen3:14b' },
    };
    const getProvider = buildGetProvider({ repo, cfg, factory, defaultProvider: 'local' });
    const out = await getProvider({ agentId: 'news' });
    expect(out.enabled).toBe(true);
    expect(receivedCfgs).toHaveLength(1);
    expect(receivedCfgs[0].home.fallback).toBe(true);
    expect(receivedCfgs[0].home.model).toBe('qwen3:8b');
  });

  it('overlays a runtime home_model override onto the home tier', async () => {
    const receivedCfgs = [];
    const factory = (opts, cfg) => {
      receivedCfgs.push(cfg);
      return { name: opts.type, model: opts.model, generate: async () => 'x' };
    };
    const repo = {
      getAgentConfig: async () => ({ provider: 'local', model: null, enabled: true }),
      getRuntimeConfig: async () => ({ home_model: 'qwen3:8b' }),
    };
    const cfg = { ollama: { url: 'o' }, home: { url: 'http://pc:11434', enabled: true, model: 'qwen3:14b' } };
    const getProvider = buildGetProvider({ repo, cfg, factory });
    await getProvider({ agentId: 'news' });
    expect(receivedCfgs[0].home.model).toBe('qwen3:8b');
  });
});

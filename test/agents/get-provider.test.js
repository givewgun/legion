import { describe, it, expect } from 'vitest';
import { buildGetProvider } from '../../src/agents/get-provider.js';
import { DEFAULT_MODELS } from '../../src/llm/provider.js';

function repoStub(map) {
  return { getAgentConfig: async (id) => map[id] ?? null };
}

describe('buildGetProvider', () => {
  it('returns null when the agent has no persisted config (keep static provider)', async () => {
    const getProvider = buildGetProvider({
      repo: repoStub({}),
      cfg: {},
      factory: () => ({ generate: async () => '' }),
    });
    expect(await getProvider({ agentId: 'technical' })).toBeNull();
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

  it('fills the default model when the row has none', async () => {
    const calls = [];
    const factory = (opts) => {
      calls.push(opts);
      return { generate: async () => '' };
    };
    const repo = repoStub({ news: { provider: 'local', model: null, enabled: true } });
    const getProvider = buildGetProvider({ repo, cfg: {}, factory });
    await getProvider({ agentId: 'news' });
    expect(calls[0]).toEqual({ type: 'local', model: DEFAULT_MODELS.local });
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
});

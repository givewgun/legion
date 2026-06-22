import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createAgent } from '../../src/agents/factory.js';
import { cycleSubject, voteSubject } from '../../src/bus/subjects.js';

function baseDeps(overrides = {}) {
  return {
    id: 'technical',
    weight: 1.0,
    gather: async () => ({}),
    buildPrompt: () => ({ system: 's', prompt: 'p' }),
    bus: createMemoryBus(),
    gunvest: {},
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

describe('factory per-cycle provider', () => {
  it('uses getProvider(agentId) when supplied', async () => {
    const used = [];
    const provider = { generate: async () => '{"stance":1,"conviction":0.7,"rationale":"r"}' };
    const deps = baseDeps({
      getProvider: async ({ agentId }) => {
        used.push(agentId);
        return { provider, enabled: true };
      },
    });
    const published = [];
    deps.bus.subscribeJSON(voteSubject('NVDA', 1), (m) => published.push(m));
    const agent = createAgent(deps);
    agent.start();
    deps.bus.publishJSON(cycleSubject('NVDA'), { cycleId: 1, symbol: 'NVDA', round: 1 });
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(used).toEqual(['technical']);
    expect(published[0].vote.stance).toBe(1);
  });

  it('abstains (HOLD/0) without calling the LLM when disabled', async () => {
    let generated = false;
    const provider = {
      generate: async () => {
        generated = true;
        return '';
      },
    };
    const deps = baseDeps({
      getProvider: async () => ({ provider, enabled: false }),
    });
    const published = [];
    deps.bus.subscribeJSON(voteSubject('NVDA', 1), (m) => published.push(m));
    const agent = createAgent(deps);
    agent.start();
    deps.bus.publishJSON(cycleSubject('NVDA'), { cycleId: 1, symbol: 'NVDA', round: 1 });
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(generated).toBe(false);
    expect(published[0].vote.stance).toBe(0);
  });

  it('tags the published vote with the served model and source', async () => {
    const provider = {
      generate: async () => ({
        text: '{"stance":1,"conviction":0.5,"rationale":"x"}',
        model: 'gpt-oss:20b',
        source: 'pc',
      }),
    };
    const deps = baseDeps({
      getProvider: async () => ({ provider, enabled: true }),
    });
    const published = [];
    deps.bus.subscribeJSON(voteSubject('NVDA', 1), (m) => published.push(m));
    const agent = createAgent(deps);
    agent.start();
    deps.bus.publishJSON(cycleSubject('NVDA'), { cycleId: 1, symbol: 'NVDA', round: 1 });
    await vi.waitFor(() => expect(published).toHaveLength(1));
    const publishedVote = published[0].vote;
    expect(publishedVote.model).toBe('gpt-oss:20b');
    expect(publishedVote.source).toBe('pc');
  });
});

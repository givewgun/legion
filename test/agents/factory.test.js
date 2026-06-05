import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createAgent } from '../../src/agents/factory.js';
import { cycleSubject, voteSubject } from '../../src/bus/subjects.js';

function setup({ generateImpl, buildPrompt }) {
  const bus = createMemoryBus();
  const gunvest = { getThing: async () => ({ ok: true }) };
  const provider = { name: 'local', generate: vi.fn(generateImpl) };
  const agent = createAgent({
    id: 'news',
    weight: 1.3,
    gather: async (gv, symbol) => ({ symbol }),
    buildPrompt: buildPrompt ?? ((symbol) => ({ system: 'sys', prompt: `p ${symbol}` })),
    bus,
    gunvest,
    provider,
  });
  agent.start();
  return { bus, provider };
}

describe('createAgent', () => {
  it('publishes a parsed vote carrying the agent id and weight', async () => {
    const { bus } = setup({
      generateImpl: async () => '{"stance": 1, "conviction": 0.6, "rationale": "catalyst"}',
    });
    const votes = [];
    bus.subscribeJSON(voteSubject('NVDA', 1), (m) => votes.push(m));

    bus.publishJSON(cycleSubject('NVDA'), { cycleId: 3, symbol: 'NVDA', round: 1 });
    await vi.waitFor(() => expect(votes.length).toBe(1));

    expect(votes[0].vote).toMatchObject({
      agentId: 'news',
      weight: 1.3,
      stance: 1,
      conviction: 0.6,
    });
  });

  it('passes a dissent summary to buildPrompt on round >= 2', async () => {
    const buildPrompt = vi.fn(() => ({ system: 's', prompt: 'p' }));
    const { bus } = setup({
      generateImpl: async () => '{"stance": 0, "conviction": 0.1, "rationale": "x"}',
      buildPrompt,
    });

    bus.publishJSON(cycleSubject('MU'), {
      cycleId: 9,
      symbol: 'MU',
      round: 2,
      priorVotes: [
        { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
        { agentId: 'news', stance: -1, conviction: 0.4, weight: 1, rationale: 'soft' },
      ],
    });
    await vi.waitFor(() => expect(buildPrompt).toHaveBeenCalled());

    const peersArg = buildPrompt.mock.calls[0][2];
    expect(peersArg).toContain('technical');
    expect(peersArg).not.toContain('news'); // own prior vote excluded
  });

  it('abstains with HOLD/0 when output is unparseable', async () => {
    const { bus } = setup({ generateImpl: async () => 'cannot decide' });
    const votes = [];
    bus.subscribeJSON(voteSubject('MU', 1), (m) => votes.push(m));

    bus.publishJSON(cycleSubject('MU'), { cycleId: 1, symbol: 'MU', round: 1 });
    await vi.waitFor(() => expect(votes.length).toBe(1));

    expect(votes[0].vote).toMatchObject({ agentId: 'news', stance: 0, conviction: 0, weight: 1.3 });
  });
});

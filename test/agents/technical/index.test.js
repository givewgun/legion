import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../../src/bus/memory.js';
import { createTechnicalAgent } from '../../../src/agents/technical/index.js';
import { cycleSubject, voteSubject } from '../../../src/bus/subjects.js';

function setup(generateImpl) {
  const bus = createMemoryBus();
  const gunvest = { getPrice: async (s) => ({ symbol: s, price: 100 }) };
  const provider = { name: 'local', generate: vi.fn(generateImpl) };
  const agent = createTechnicalAgent({
    bus,
    gunvest,
    provider,
    config: { id: 'technical', weight: 1.0 },
  });
  agent.start();
  return { bus, provider };
}

describe('createTechnicalAgent', () => {
  it('publishes a parsed vote in response to a cycle', async () => {
    const { bus } = setup(async () => '{"stance": 2, "conviction": 0.9, "rationale": "breakout"}');
    const votes = [];
    bus.subscribeJSON(voteSubject('NVDA', 1), (m) => votes.push(m));

    bus.publishJSON(cycleSubject('NVDA'), { cycleId: 7, symbol: 'NVDA', round: 1 });
    await vi.waitFor(() => expect(votes.length).toBe(1));

    expect(votes[0]).toMatchObject({
      cycleId: 7,
      symbol: 'NVDA',
      round: 1,
      vote: {
        agentId: 'technical',
        stance: 2,
        conviction: 0.9,
        weight: 1.0,
        rationale: 'breakout',
      },
    });
  });

  it('abstains with a HOLD/0 vote when the LLM output is unparseable', async () => {
    const { bus } = setup(async () => 'I cannot decide.');
    const votes = [];
    bus.subscribeJSON(voteSubject('MU', 1), (m) => votes.push(m));

    bus.publishJSON(cycleSubject('MU'), { cycleId: 9, symbol: 'MU', round: 1 });
    await vi.waitFor(() => expect(votes.length).toBe(1));

    expect(votes[0].vote).toMatchObject({
      agentId: 'technical',
      stance: 0,
      conviction: 0,
      weight: 1.0,
    });
  });
});

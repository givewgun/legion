import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createOrchestrator } from '../../src/orchestrator.js';
import { createTechnicalAgent } from '../../src/agents/technical/index.js';
import { createEmitter } from '../../src/emit/emitter.js';

describe('Legion Phase 1 pipeline', () => {
  it('flows a single ticker from kick to emitted signal', async () => {
    const bus = createMemoryBus();
    const telegram = vi.fn(async () => {});
    const signals = [];
    const repo = {
      createCycle: vi.fn(async () => 1),
      addRound: vi.fn(async () => 10),
      addVote: vi.fn(async () => 100),
      addSignal: vi.fn(async (cycleId, signal) => {
        signals.push(signal);
        return 1000;
      }),
      finishCycle: vi.fn(async () => {}),
    };
    const gunvest = { getPrice: async (s) => ({ symbol: s, price: 120, changePercent: 3 }) };
    const provider = {
      name: 'local',
      generate: async () => '{"stance": 2, "conviction": 0.85, "rationale": "strong uptrend"}',
    };

    createTechnicalAgent({
      bus,
      gunvest,
      provider,
      config: { id: 'technical', weight: 1.0 },
    }).start();

    createEmitter({
      bus,
      repo,
      telegram,
      consensus: { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 },
      expectedAgents: 1,
    }).start();

    const orch = createOrchestrator({ bus, repo });
    await orch.kick('NVDA');

    await vi.waitFor(() => expect(telegram).toHaveBeenCalledTimes(1));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ symbol: 'NVDA', band: 'STRONG_BUY' });
    expect(repo.finishCycle).toHaveBeenCalledWith(1, 'converged');
  });
});

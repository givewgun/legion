import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createOrchestrator } from '../../src/orchestrator.js';
import { createAgent } from '../../src/agents/factory.js';
import { createRiskManager } from '../../src/risk/manager.js';
import { createEmitter } from '../../src/emit/emitter.js';

const consensus = { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5, maxRounds: 3 };

// A stub voting agent that always returns a fixed stance/conviction.
function stubAgent(bus, gunvest, { id, weight, stance, conviction }) {
  const provider = {
    name: 'stub',
    generate: async () =>
      `{"stance": ${stance}, "conviction": ${conviction}, "rationale": "${id} says ${stance}"}`,
  };
  return createAgent({
    id,
    weight,
    gather: async () => ({}),
    buildPrompt: () => ({ system: 's', prompt: 'p' }),
    bus,
    gunvest,
    provider,
  });
}

function fakeRepo(sink) {
  return {
    createCycle: vi.fn(async () => 1),
    addRound: vi.fn(async () => 10),
    addVote: vi.fn(async () => 100),
    addSignal: vi.fn(async (cycleId, signal) => {
      sink.signals.push(signal);
      return 1000;
    }),
    finishCycle: vi.fn(async (cycleId, status) => {
      sink.status = status;
    }),
  };
}

describe('Legion Phase 2 consensus', () => {
  it('reaches converged BUY consensus with the risk constraint applied', async () => {
    const bus = createMemoryBus();
    const sink = { signals: [], status: null };
    const repo = fakeRepo(sink);
    const telegram = vi.fn(async () => {});
    const gunvest = {
      getPrice: async () => ({ changePercent: 1 }),
      getMacro: async () => ({ vix: 33 }), // -> capConviction 0.5
      getNews: async () => [],
      getSentiment: async () => ({ score: 0.5 }),
    };

    // 3 buys + 1 mild buy -> quorum on the buy side, low dispersion -> converge
    stubAgent(bus, gunvest, { id: 'technical', weight: 1.0, stance: 2, conviction: 0.9 }).start();
    stubAgent(bus, gunvest, { id: 'news', weight: 1.2, stance: 1, conviction: 0.8 }).start();
    stubAgent(bus, gunvest, { id: 'social', weight: 0.8, stance: 1, conviction: 0.6 }).start();
    stubAgent(bus, gunvest, { id: 'contrarian', weight: 0.9, stance: 1, conviction: 0.4 }).start();
    createRiskManager({ bus, gunvest }).start();

    createEmitter({ bus, repo, telegram, consensus, expectedAgents: 4, riskEnabled: true }).start();

    const orch = createOrchestrator({ bus, repo });
    await orch.kick('NVDA');

    await vi.waitFor(() => expect(telegram).toHaveBeenCalledTimes(1));
    expect(sink.status).toBe('converged');
    expect(sink.signals).toHaveLength(1);
    expect(['BUY', 'STRONG_BUY']).toContain(sink.signals[0].band);
    expect(sink.signals[0].conviction).toBeLessThanOrEqual(0.5); // risk cap
    expect(sink.signals[0].plan.riskReason).toMatch(/VIX/);
  });

  it('iterates to a second round when round 1 is split, then converges', async () => {
    const bus = createMemoryBus();
    const sink = { signals: [], status: null };
    const repo = fakeRepo(sink);
    const gunvest = {
      getPrice: async () => ({ changePercent: 1 }),
      getMacro: async () => ({ vix: 14 }),
      getNews: async () => [],
      getSentiment: async () => ({ score: 0.5 }),
    };

    // Two agents flip from a split in round 1 to agreement in round 2 once they
    // see peer dissent (priorVotes present).
    function flipAgent(id, weight, round1Stance) {
      const provider = {
        name: 'stub',
        generate: async ({ prompt }) => {
          const stance = prompt.includes('prior round') ? 1 : round1Stance;
          return `{"stance": ${stance}, "conviction": 0.8, "rationale": "${id}"}`;
        },
      };
      return createAgent({
        id,
        weight,
        gather: async () => ({}),
        buildPrompt: (symbol, data, peers) => ({
          system: 's',
          prompt: `analyze${peers ? '\nprior round\n' + peers : ''}`,
        }),
        bus,
        gunvest,
        provider,
      });
    }

    flipAgent('technical', 1.0, 2).start();
    flipAgent('news', 1.2, -2).start();
    flipAgent('social', 0.8, 2).start();
    flipAgent('contrarian', 0.9, -1).start();

    createEmitter({
      bus,
      repo,
      telegram: vi.fn(async () => {}),
      consensus,
      expectedAgents: 4,
    }).start();

    const orch = createOrchestrator({ bus, repo });
    await orch.kick('MU');

    await vi.waitFor(() => expect(sink.status).not.toBeNull());
    expect(sink.status).toBe('converged');
    expect(repo.addRound).toHaveBeenCalledTimes(2); // round 1 (split) + round 2 (converged)
  });
});

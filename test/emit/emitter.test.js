import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createEmitter } from '../../src/emit/emitter.js';
import { voteSubject, consensusSubject } from '../../src/bus/subjects.js';

function fakeRepo() {
  return {
    createCycle: vi.fn(async () => 1),
    addRound: vi.fn(async () => 10),
    addVote: vi.fn(async () => 100),
    addSignal: vi.fn(async () => 1000),
    finishCycle: vi.fn(async () => {}),
  };
}

describe('createEmitter', () => {
  it('evaluates after expected votes, persists, notifies, and publishes consensus', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const telegram = vi.fn(async () => {});
    const consensusMsgs = [];
    bus.subscribeJSON(consensusSubject('NVDA'), (m) => consensusMsgs.push(m));

    createEmitter({
      bus,
      repo,
      telegram,
      consensus: { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 },
      expectedAgents: 1,
    }).start();

    bus.publishJSON(voteSubject('NVDA', 1), {
      cycleId: 1,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
    });

    await vi.waitFor(() => expect(telegram).toHaveBeenCalledTimes(1));
    expect(repo.addRound).toHaveBeenCalledTimes(1);
    expect(repo.addVote).toHaveBeenCalledTimes(1);
    expect(repo.addSignal).toHaveBeenCalledTimes(1);
    expect(repo.finishCycle).toHaveBeenCalledWith(1, 'converged');
    expect(consensusMsgs[0]).toMatchObject({ cycleId: 1, symbol: 'NVDA', band: 'STRONG_BUY' });
  });

  it('finishes as no_consensus when the round does not converge', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const telegram = vi.fn(async () => {});

    createEmitter({
      bus,
      repo,
      telegram,
      consensus: { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 },
      expectedAgents: 2,
    }).start();

    bus.publishJSON(voteSubject('MU', 1), {
      cycleId: 2,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 1, weight: 1, rationale: 'up' },
    });
    bus.publishJSON(voteSubject('MU', 1), {
      cycleId: 2,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'news', stance: -2, conviction: 1, weight: 1, rationale: 'down' },
    });

    await vi.waitFor(() => expect(repo.finishCycle).toHaveBeenCalledWith(2, 'no_consensus'));
  });
});

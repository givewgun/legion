import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createEmitter } from '../../src/emit/emitter.js';
import {
  voteSubject,
  constraintSubject,
  cycleSubject,
  consensusSubject,
} from '../../src/bus/subjects.js';

const consensus = { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5, maxRounds: 3 };

function fakeRepo() {
  return {
    addRound: vi.fn(async () => 10),
    addVote: vi.fn(async () => 100),
    addSignal: vi.fn(async () => 1000),
    finishCycle: vi.fn(async () => {}),
  };
}

function emitVote(bus, { cycleId, symbol, round, vote }) {
  bus.publishJSON(voteSubject(symbol, round), { cycleId, symbol, round, vote });
}

describe('createEmitter (v2)', () => {
  it('finalizes a converged round: persists, notifies, publishes consensus', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const telegram = vi.fn(async () => {});
    const out = [];
    bus.subscribeJSON(consensusSubject('NVDA'), (m) => out.push(m));

    createEmitter({ bus, repo, telegram, consensus, expectedAgents: 2 }).start();

    emitVote(bus, {
      cycleId: 1,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
    });
    emitVote(bus, {
      cycleId: 1,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'news', stance: 2, conviction: 0.8, weight: 1, rationale: 'beat' },
    });

    await vi.waitFor(() => expect(telegram).toHaveBeenCalledTimes(1));
    expect(repo.addRound).toHaveBeenCalledTimes(1);
    expect(repo.addVote).toHaveBeenCalledTimes(2);
    expect(repo.finishCycle).toHaveBeenCalledWith(1, 'converged');
    expect(out[0]).toMatchObject({ cycleId: 1, symbol: 'NVDA', band: 'STRONG_BUY' });
  });

  it('iterates: a split round 1 republishes a round 2 request carrying priorVotes', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const requests = [];
    bus.subscribeJSON(cycleSubject('MU'), (m) => requests.push(m));

    createEmitter({
      bus,
      repo,
      telegram: vi.fn(async () => {}),
      consensus,
      expectedAgents: 2,
    }).start();

    // opposed strong votes -> high dispersion -> not converged
    emitVote(bus, {
      cycleId: 2,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 1, weight: 1, rationale: 'up' },
    });
    emitVote(bus, {
      cycleId: 2,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'news', stance: -2, conviction: 1, weight: 1, rationale: 'down' },
    });

    await vi.waitFor(() => expect(requests.length).toBe(1));
    expect(requests[0]).toMatchObject({ cycleId: 2, symbol: 'MU', round: 2 });
    expect(requests[0].priorVotes).toHaveLength(2);
    expect(repo.addRound).toHaveBeenCalledTimes(1); // round 1 persisted
    expect(repo.finishCycle).not.toHaveBeenCalled();
  });

  it('emits no_consensus when the final round is still split', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const onePassConsensus = { ...consensus, maxRounds: 1 };

    createEmitter({
      bus,
      repo,
      telegram: vi.fn(async () => {}),
      consensus: onePassConsensus,
      expectedAgents: 2,
    }).start();

    emitVote(bus, {
      cycleId: 3,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 1, weight: 1, rationale: 'up' },
    });
    emitVote(bus, {
      cycleId: 3,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'news', stance: -2, conviction: 1, weight: 1, rationale: 'down' },
    });

    await vi.waitFor(() => expect(repo.finishCycle).toHaveBeenCalledWith(3, 'no_consensus'));
  });

  it('waits for the risk constraint before finalizing and applies it', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const out = [];
    bus.subscribeJSON(consensusSubject('NVDA'), (m) => out.push(m));

    createEmitter({
      bus,
      repo,
      telegram: vi.fn(async () => {}),
      consensus,
      expectedAgents: 1,
      riskEnabled: true,
    }).start();

    // vote arrives first — must NOT finalize yet (no constraint)
    emitVote(bus, {
      cycleId: 4,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
    });
    expect(repo.finishCycle).not.toHaveBeenCalled();

    bus.publishJSON(constraintSubject('NVDA', 1), {
      cycleId: 4,
      symbol: 'NVDA',
      round: 1,
      constraint: { capConviction: 0.5, blockBuy: false, reason: 'elevated VIX 31' },
    });

    await vi.waitFor(() => expect(repo.finishCycle).toHaveBeenCalledWith(4, 'converged'));
    expect(out[0].conviction).toBe(0.5); // capped
    expect(out[0].plan.riskCapped).toBe(true);
  });
});

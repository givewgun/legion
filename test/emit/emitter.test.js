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
    addSignalVotes: vi.fn(async () => {}),
    getAllReliability: vi.fn(async () => ({})),
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

  it('captures entry prices from gunvest at fire time and persists them on the signal', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const prices = { NVDA: 920.5, SPY: 540.1, QQQ: 470.2 };
    const gunvest = {
      getPrice: vi.fn(async (symbol) => ({ price: prices[symbol] })),
    };

    createEmitter({
      bus,
      repo,
      telegram: vi.fn(async () => {}),
      consensus,
      expectedAgents: 2,
      gunvest,
    }).start();

    emitVote(bus, {
      cycleId: 5,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
    });
    emitVote(bus, {
      cycleId: 5,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'news', stance: 2, conviction: 0.8, weight: 1, rationale: 'beat' },
    });

    await vi.waitFor(() => expect(repo.addSignal).toHaveBeenCalledTimes(1));
    const [, signal] = repo.addSignal.mock.calls[0];
    expect(signal).toMatchObject({
      entryPrice: prices.NVDA,
      spyEntryPrice: prices.SPY,
      qqqEntryPrice: prices.QQQ,
    });
    expect(gunvest.getPrice).toHaveBeenCalledWith('NVDA');
    expect(gunvest.getPrice).toHaveBeenCalledWith('SPY');
    expect(gunvest.getPrice).toHaveBeenCalledWith('QQQ');
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

  it('does not leak: cleans up after a healthy cycle and evicts orphaned buffers', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    let nowMs = 1_000_000;
    const staleEntryMs = 60_000;
    const emitter = createEmitter({
      bus,
      repo,
      telegram: vi.fn(async () => {}),
      consensus,
      expectedAgents: 2,
      staleEntryMs,
      clock: () => new Date(nowMs),
      logger,
    });
    emitter.start();

    // Healthy converged cycle leaves no residue in any buffer.
    emitVote(bus, {
      cycleId: 6,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'a' },
    });
    emitVote(bus, {
      cycleId: 6,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'news', stance: 2, conviction: 0.8, weight: 1, rationale: 'b' },
    });
    await vi.waitFor(() => expect(emitter.stats()).toEqual({ pendingRounds: 0, pendingCycles: 0 }));

    // Only one of two expected agents votes — the round never completes and buffers.
    emitVote(bus, {
      cycleId: 8,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'technical', stance: 1, conviction: 0.5, weight: 1, rationale: 'x' },
    });
    expect(emitter.stats()).toEqual({ pendingRounds: 1, pendingCycles: 1 });
    expect(repo.finishCycle).toHaveBeenCalledTimes(1); // only the healthy cycle 6

    // Advance past the stale window; the next message's lazy sweep drops the orphan.
    nowMs += staleEntryMs + 1;
    emitVote(bus, {
      cycleId: 9,
      symbol: 'TSLA',
      round: 1,
      vote: { agentId: 'technical', stance: 1, conviction: 0.5, weight: 1, rationale: 'z' },
    });

    // Cycle 8's orphan is evicted; only the just-arrived cycle 9 remains.
    expect(emitter.stats()).toEqual({ pendingRounds: 1, pendingCycles: 1 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('evicted 1 stale round'));
  });

  it('keeps a slow multi-round cycle alive: round-1 priors survive a sweep so the herding guard still fires', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const requests = [];
    bus.subscribeJSON(cycleSubject('MU'), (m) => requests.push(m));
    let nowMs = 1_000_000;
    const staleEntryMs = 60_000;
    // priorQuorum arms the anti-herding guard: a converged revision must retain
    // >= 0.6 independent round-1 backing or it is treated as social pressure.
    const herdConsensus = { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5, maxRounds: 3, priorQuorum: 0.6 };
    createEmitter({
      bus,
      repo,
      telegram: vi.fn(async () => {}),
      consensus: herdConsensus,
      expectedAgents: 2,
      staleEntryMs,
      clock: () => new Date(nowMs),
    }).start();

    // Round 1: opposed strong votes -> not converged -> republish round 2. Records
    // the independent priors (technical +, news -). Second vote arrives slowly but
    // within the window.
    emitVote(bus, {
      cycleId: 20,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 1, weight: 1, rationale: 'up' },
    });
    nowMs += 40_000;
    emitVote(bus, {
      cycleId: 20,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'news', stance: -2, conviction: 1, weight: 1, rationale: 'down' },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].round).toBe(2);

    // Round 2 lands late: total span since the first vote (90s) exceeds staleEntryMs,
    // but the gap since last activity (50s) does not. The sweep on the next message
    // must NOT evict cycle 20's priors. Both agents now swing to + — agreement that
    // only emerges under peer pressure.
    nowMs += 50_000;
    emitVote(bus, {
      cycleId: 20,
      symbol: 'MU',
      round: 2,
      vote: { agentId: 'technical', stance: 2, conviction: 1, weight: 1, rationale: 'up' },
    });
    emitVote(bus, {
      cycleId: 20,
      symbol: 'MU',
      round: 2,
      vote: { agentId: 'news', stance: 2, conviction: 1, weight: 1, rationale: 'flip' },
    });

    // With priors preserved, independent backing for + is only 0.5 (one of two
    // round-1 agents) < 0.6 -> herding guard blocks convergence -> republish round 3,
    // NOT finalize. If the priors had been evicted and reseeded from round 2, backing
    // would be 1.0 and it would wrongly converge.
    await vi.waitFor(() => expect(repo.addRound).toHaveBeenCalledTimes(2));
    expect(repo.finishCycle).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    expect(requests[1].round).toBe(3);
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

  it('keeps a slow round alive while votes keep arriving: staleness is gap since last activity, not age since first vote', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    let nowMs = 1_000_000;
    const staleEntryMs = 60_000;
    createEmitter({
      bus,
      repo,
      telegram: vi.fn(async () => {}),
      consensus,
      expectedAgents: 3,
      staleEntryMs,
      clock: () => new Date(nowMs),
    }).start();

    // Three agents drain a saturated LLM queue: votes land 40s and 25s apart.
    // Total round span (65s) exceeds staleEntryMs, but no activity gap does —
    // the sweep on the third vote must not evict the first two.
    const vote = (agentId) =>
      emitVote(bus, {
        cycleId: 30,
        symbol: 'TSM',
        round: 1,
        vote: { agentId, stance: 2, conviction: 0.9, weight: 1, rationale: 'up' },
      });
    vote('technical');
    nowMs += 40_000;
    vote('news');
    nowMs += 25_000;
    vote('contrarian');

    await vi.waitFor(() => expect(repo.finishCycle).toHaveBeenCalledWith(30, 'converged'));
  });

  it('times out abandoned running cycles in the DB on sweep, sparing cycles still active in memory', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    repo.timeoutStaleCycles = vi.fn(async () => [{ id: 8, symbol: 'MU' }]);
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    let nowMs = 1_000_000;
    const staleEntryMs = 60_000;
    createEmitter({
      bus,
      repo,
      telegram: vi.fn(async () => {}),
      consensus,
      expectedAgents: 2,
      staleEntryMs,
      clock: () => new Date(nowMs),
      logger,
    }).start();

    // Cycle 8 gets one of two votes, then goes silent past the stale horizon.
    emitVote(bus, {
      cycleId: 8,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'technical', stance: 1, conviction: 0.5, weight: 1, rationale: 'x' },
    });
    // Cycle 9 stays active: its last vote is only 25s old at the next sweep.
    nowMs += 40_000;
    emitVote(bus, {
      cycleId: 9,
      symbol: 'TSLA',
      round: 1,
      vote: { agentId: 'technical', stance: 1, conviction: 0.5, weight: 1, rationale: 'y' },
    });
    nowMs += 25_000;
    emitVote(bus, {
      cycleId: 10,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'technical', stance: 1, conviction: 0.5, weight: 1, rationale: 'z' },
    });

    // The sweep must close cycle 8 in the DB (not just drop its buffer) and
    // pass the still-active cycle 9 as protected.
    await vi.waitFor(() =>
      expect(repo.timeoutStaleCycles).toHaveBeenCalledWith(
        new Date(nowMs - staleEntryMs).toISOString(),
        [9],
      ),
    );
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out 1')),
    );
  });
});

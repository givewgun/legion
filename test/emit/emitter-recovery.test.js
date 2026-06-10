import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createEmitter } from '../../src/emit/emitter.js';
import { voteSubject } from '../../src/bus/subjects.js';

const consensus = { thetaV: 0.75, quorum: 2 / 3, holdBand: 0.5, maxRounds: 3, priorQuorum: 1 / 3 };

const mkVote = (agentId, stance, conviction = 0.9) => ({
  agentId,
  stance,
  conviction,
  weight: 1,
  rationale: agentId,
});

const bullVotes = [
  mkVote('technical', 1),
  mkVote('news', 1),
  mkVote('social', 1),
  mkVote('contrarian', 1),
];

// Repo double with the ADR 0024 pending-state surface. `pendingVotes` /
// `pendingConstraints` seed what a previous (crashed) emitter persisted.
function recoveryRepo({ pendingVotes = [], pendingConstraints = [], existingRounds = [] } = {}) {
  const calls = {
    savedVotes: [],
    savedConstraints: [],
    deletedCycles: [],
    rounds: [],
    signals: [],
  };
  return {
    calls,
    addRound: async (cycleId, roundNo, result) => {
      calls.rounds.push({ cycleId, roundNo, result });
      return calls.rounds.length;
    },
    addVote: async () => {},
    addSignal: async (_cycleId, s) => {
      calls.signals.push(s);
      return 99;
    },
    addSignalVotes: async () => {},
    finishCycle: async () => {},
    getAllReliability: async () => ({}),
    savePendingVote: async (cycleId, round, symbol, vote) =>
      calls.savedVotes.push({ cycleId, round, symbol, vote }),
    savePendingConstraint: async (cycleId, round, symbol, constraint) =>
      calls.savedConstraints.push({ cycleId, round, symbol, constraint }),
    loadPendingVotes: async () => pendingVotes,
    loadPendingConstraints: async () => pendingConstraints,
    deletePendingCycle: async (cycleId) => calls.deletedCycles.push(cycleId),
    deletePendingBefore: async () => {},
    roundExists: async (cycleId, roundNo) =>
      existingRounds.some(([c, r]) => c === cycleId && r === roundNo),
  };
}

function build(repo, overrides = {}) {
  const bus = createMemoryBus();
  const emitter = createEmitter({
    bus,
    repo,
    telegram: async () => {},
    consensus,
    expectedAgents: 4,
    riskEnabled: false,
    gunvest: { getPrice: async () => ({ price: 100 }) },
    clock: () => new Date('2026-06-04T00:00:00Z'),
    logger: { info() {}, error() {} },
    ...overrides,
  });
  return { bus, emitter };
}

const pendingRow = (cycleId, round, vote) => ({ cycle_id: cycleId, round, symbol: 'NVDA', vote });

describe('emitter crash recovery (ADR 0024)', () => {
  it('persists each arriving vote and constraint to the pending tables', async () => {
    const repo = recoveryRepo();
    const { bus, emitter } = build(repo, { riskEnabled: false });
    await emitter.start();

    bus.publishJSON(voteSubject('NVDA', 1), {
      cycleId: 7,
      symbol: 'NVDA',
      round: 1,
      vote: mkVote('technical', 1),
    });
    await vi.waitFor(() => expect(repo.calls.savedVotes).toHaveLength(1));
    expect(repo.calls.savedVotes[0]).toMatchObject({ cycleId: 7, round: 1, symbol: 'NVDA' });
  });

  it('deletes a cycle’s pending rows on finalize', async () => {
    const repo = recoveryRepo();
    const { bus, emitter } = build(repo);
    await emitter.start();

    for (const vote of bullVotes) {
      bus.publishJSON(voteSubject('NVDA', 1), { cycleId: 7, symbol: 'NVDA', round: 1, vote });
    }
    await vi.waitFor(() => expect(repo.calls.signals).toHaveLength(1));
    expect(repo.calls.deletedCycles).toEqual([7]);
  });

  it('resumes a complete pre-crash round and emits the signal', async () => {
    const repo = recoveryRepo({
      pendingVotes: bullVotes.map((v) => pendingRow(7, 1, v)),
    });
    const { emitter } = build(repo);
    await emitter.start();

    expect(repo.calls.rounds).toHaveLength(1);
    expect(repo.calls.signals).toHaveLength(1);
    expect(repo.calls.signals[0].band).toBe('BUY');
  });

  it('does not re-aggregate a round that was already persisted before the crash', async () => {
    const repo = recoveryRepo({
      pendingVotes: bullVotes.map((v) => pendingRow(7, 1, v)),
      existingRounds: [[7, 1]],
    });
    const { emitter } = build(repo);
    await emitter.start();

    expect(repo.calls.rounds).toHaveLength(0);
    expect(repo.calls.signals).toHaveLength(0);
  });

  it('restores round-1 priors so the herding guard still blocks after a restart', async () => {
    // Pre-crash round 1: lone bull vs three bears (BUY backing 0.25 < priorQuorum),
    // already aggregated (round exists). The emitter crashed, restarted, and the
    // round-2 unanimous flip arrives post-restart: without restored priors this
    // would emit a herded BUY.
    const round1 = [
      mkVote('technical', 1),
      mkVote('news', -1),
      mkVote('social', -1),
      mkVote('contrarian', -1),
    ];
    const repo = recoveryRepo({
      pendingVotes: round1.map((v) => pendingRow(7, 1, v)),
      existingRounds: [[7, 1]],
    });
    // round 2 is the cap so a blocked convergence finalizes as NO_CONSENSUS
    const { bus, emitter } = build(repo, { consensus: { ...consensus, maxRounds: 2 } });
    await emitter.start();

    for (const vote of bullVotes) {
      bus.publishJSON(voteSubject('NVDA', 2), { cycleId: 7, symbol: 'NVDA', round: 2, vote });
    }
    await vi.waitFor(() => expect(repo.calls.signals).toHaveLength(1));
    expect(repo.calls.rounds.at(-1).result.converged).toBe(false);
    expect(repo.calls.signals[0].band).toBe('NO_CONSENSUS');
  });

  it('merges a recovered partial round with votes that arrive live, deduped by agent', async () => {
    // Three votes survived in the pending table; the fourth arrives after restart.
    const repo = recoveryRepo({
      pendingVotes: bullVotes.slice(0, 3).map((v) => pendingRow(7, 1, v)),
    });
    const { bus, emitter } = build(repo);
    await emitter.start();
    expect(repo.calls.signals).toHaveLength(0); // not ready yet

    bus.publishJSON(voteSubject('NVDA', 1), {
      cycleId: 7,
      symbol: 'NVDA',
      round: 1,
      vote: bullVotes[3],
    });
    await vi.waitFor(() => expect(repo.calls.signals).toHaveLength(1));
    expect(repo.calls.signals[0].band).toBe('BUY');
  });

  it('runs without any pending-state repo surface (memory-only mode)', async () => {
    const bus = createMemoryBus();
    const repo = {
      addRound: async () => 1,
      addVote: async () => {},
      addSignal: async (_c, s) => {
        repo.signals.push(s);
        return 1;
      },
      signals: [],
      addSignalVotes: async () => {},
      finishCycle: async () => {},
    };
    const emitter = createEmitter({
      bus,
      repo,
      telegram: async () => {},
      consensus,
      expectedAgents: 4,
      riskEnabled: false,
      clock: () => new Date('2026-06-04T00:00:00Z'),
      logger: { info() {}, error() {} },
    });
    await emitter.start();
    for (const vote of bullVotes) {
      bus.publishJSON(voteSubject('NVDA', 1), { cycleId: 1, symbol: 'NVDA', round: 1, vote });
    }
    await vi.waitFor(() => expect(repo.signals).toHaveLength(1));
  });
});

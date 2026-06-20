import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createEmitter } from '../../src/emit/emitter.js';
import { voteSubject, cycleSubject } from '../../src/bus/subjects.js';

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
// `cycle` / `persistedRounds` / `persistedVotes` / `hasSignal` describe the
// pre-crash DB state the resume path inspects (methods only present when given,
// so tests without them exercise the conservative no-resume behaviour).
function recoveryRepo({
  pendingVotes = [],
  pendingConstraints = [],
  existingRounds = [],
  cycle = null,
  persistedRounds = null,
  persistedVotes = {},
  hasSignal = false,
} = {}) {
  const calls = {
    savedVotes: [],
    savedConstraints: [],
    deletedCycles: [],
    rounds: [],
    signals: [],
    finished: [],
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
    finishCycle: async (cycleId, status) => calls.finished.push({ cycleId, status }),
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
    ...(cycle && {
      getCycle: async () => cycle,
      getRounds: async () => persistedRounds ?? [],
      getVotes: async (roundId) => persistedVotes[roundId] ?? [],
      cycleHasSignal: async () => hasSignal,
    }),
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

  describe('resuming the post-round action a crash swallowed', () => {
    // The persisted, calibrated round votes as repo.getVotes would return them —
    // NUMERIC columns come back as strings from node-postgres.
    const persistedVoteRows = (votes) =>
      votes.map((v) => ({
        agent_id: v.agentId,
        stance: v.stance,
        conviction: String(v.conviction),
        weight: String(v.weight),
        rationale: v.rationale,
      }));

    it('re-publishes round+1 when the crash hit between addRound and the republish', async () => {
      // Round 1 persisted (not converged), cycle still running, no successor.
      const round1 = [
        mkVote('technical', 1),
        mkVote('news', -1),
        mkVote('social', -1),
        mkVote('contrarian', -1),
      ];
      const repo = recoveryRepo({
        pendingVotes: round1.map((v) => pendingRow(7, 1, v)),
        existingRounds: [[7, 1]],
        cycle: { id: 7, status: 'running' },
        persistedRounds: [{ id: 11, round_no: 1, converged: false }],
      });
      const { bus, emitter } = build(repo);
      const kicks = [];
      bus.subscribeJSON(cycleSubject('NVDA'), (m) => kicks.push(m));
      await emitter.start();

      expect(kicks).toHaveLength(1);
      expect(kicks[0]).toMatchObject({ cycleId: 7, symbol: 'NVDA', round: 2 });
      expect(kicks[0].priorVotes).toHaveLength(4);
      expect(repo.calls.signals).toHaveLength(0); // resumed, not finalized
    });

    it('emits the signal when the crash hit between a final addRound and addSignal', async () => {
      const repo = recoveryRepo({
        pendingVotes: bullVotes.map((v) => pendingRow(7, 1, v)),
        existingRounds: [[7, 1]],
        cycle: { id: 7, status: 'running' },
        persistedRounds: [{ id: 11, round_no: 1, converged: true }],
        persistedVotes: { 11: persistedVoteRows(bullVotes) },
      });
      const { emitter } = build(repo);
      await emitter.start();

      expect(repo.calls.rounds).toHaveLength(0); // never re-aggregated
      expect(repo.calls.signals).toHaveLength(1);
      expect(repo.calls.signals[0].band).toBe('BUY');
      expect(repo.calls.finished).toEqual([{ cycleId: 7, status: 'converged' }]);
      expect(repo.calls.deletedCycles).toEqual([7]);
    });

    it('honors the recorded non-convergence at the round cap (the guard already ran)', async () => {
      // Persisted votes are unanimous (a re-evaluation WOULD converge), but the
      // pre-crash round recorded converged=false — e.g. the herding guard blocked
      // it. Recovery must replay the recorded decision, not re-derive it.
      const repo = recoveryRepo({
        pendingVotes: bullVotes.map((v) => pendingRow(7, 3, v)),
        existingRounds: [[7, 3]],
        cycle: { id: 7, status: 'running' },
        persistedRounds: [{ id: 31, round_no: 3, converged: false }],
        persistedVotes: { 31: persistedVoteRows(bullVotes) },
      });
      const { emitter } = build(repo); // maxRounds 3 -> round 3 is final either way
      await emitter.start();

      expect(repo.calls.signals).toHaveLength(1);
      expect(repo.calls.signals[0].band).toBe('NO_CONSENSUS');
      expect(repo.calls.finished).toEqual([{ cycleId: 7, status: 'no_consensus' }]);
    });

    it('only closes the cycle when the signal already landed before the crash', async () => {
      const repo = recoveryRepo({
        pendingVotes: bullVotes.map((v) => pendingRow(7, 1, v)),
        existingRounds: [[7, 1]],
        cycle: { id: 7, status: 'running' },
        persistedRounds: [{ id: 11, round_no: 1, converged: true }],
        hasSignal: true,
      });
      const { emitter } = build(repo);
      await emitter.start();

      expect(repo.calls.signals).toHaveLength(0); // never emit twice
      expect(repo.calls.finished).toEqual([{ cycleId: 7, status: 'converged' }]);
      expect(repo.calls.deletedCycles).toEqual([7]);
    });

    it('does not re-kick a round whose successor already persisted', async () => {
      // Pre-crash the cycle reached round 2: rounds 1 AND 2 are persisted (both
      // non-final), pending votes survive for both. recover() walks every ready
      // entry, so the round-1 resume must NOT re-publish round 2 (it already
      // happened) — only the round-2 resume re-publishes round 3. Re-kicking a
      // closed round makes agents re-vote it and collide on the rounds UNIQUE.
      const split = [
        mkVote('technical', 1),
        mkVote('news', -1),
        mkVote('social', -1),
        mkVote('contrarian', -1),
      ];
      const repo = recoveryRepo({
        pendingVotes: [
          ...split.map((v) => pendingRow(7, 1, v)),
          ...split.map((v) => pendingRow(7, 2, v)),
        ],
        existingRounds: [
          [7, 1],
          [7, 2],
        ],
        cycle: { id: 7, status: 'running' },
        persistedRounds: [
          { id: 11, round_no: 1, converged: false },
          { id: 12, round_no: 2, converged: false },
        ],
      });
      const { bus, emitter } = build(repo);
      const kicks = [];
      bus.subscribeJSON(cycleSubject('NVDA'), (m) => kicks.push(m));
      await emitter.start();

      expect(kicks.map((k) => k.round)).toEqual([3]);
      expect(repo.calls.rounds).toHaveLength(0); // resumed, never re-aggregated
    });

    it('skips re-emitting when a live vote completes an already-persisted round', async () => {
      // The crash-recovery republish and a live re-vote can race onto the same
      // round; the loser's addRound returns null (ON CONFLICT DO NOTHING). The
      // emitter must bail — no double vote write, no second signal — not crash.
      const repo = recoveryRepo();
      repo.addRound = async () => null; // round already owned by the racing path
      const { bus, emitter } = build(repo);
      await emitter.start();

      for (const vote of bullVotes) {
        bus.publishJSON(voteSubject('NVDA', 1), { cycleId: 7, symbol: 'NVDA', round: 1, vote });
      }
      // Give the (would-be) finalize a chance to run, then assert it was skipped.
      await vi.waitFor(() => expect(repo.calls.savedVotes).toHaveLength(4));
      expect(repo.calls.signals).toHaveLength(0);
      expect(repo.calls.finished).toHaveLength(0);
    });

    it('just tidies pending rows when the cycle already finalized', async () => {
      const repo = recoveryRepo({
        pendingVotes: bullVotes.map((v) => pendingRow(7, 1, v)),
        existingRounds: [[7, 1]],
        cycle: { id: 7, status: 'converged' },
        persistedRounds: [{ id: 11, round_no: 1, converged: true }],
      });
      const { bus, emitter } = build(repo);
      const kicks = [];
      bus.subscribeJSON(cycleSubject('NVDA'), (m) => kicks.push(m));
      await emitter.start();

      expect(kicks).toHaveLength(0);
      expect(repo.calls.signals).toHaveLength(0);
      expect(repo.calls.finished).toHaveLength(0);
      expect(repo.calls.deletedCycles).toEqual([7]);
    });
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

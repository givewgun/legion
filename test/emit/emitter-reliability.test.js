import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createEmitter } from '../../src/emit/emitter.js';
import { voteSubject } from '../../src/bus/subjects.js';

function buildRepo({
  calibration = {},
  correlations = {},
  reliability = { technical: 1.5, news: 0.5 },
  regimeReliability = null,
  regimeCalibration = null,
} = {}) {
  const calls = { signals: [], signalVotes: [], roundVotes: [], rounds: [], regimeReads: [] };
  return {
    calls,
    createCycle: async () => 1,
    addRound: async (_cycleId, _roundNo, result) => {
      calls.rounds.push(result);
      return 1;
    },
    addVote: async (_roundId, v) => calls.roundVotes.push(v),
    addSignal: async (_cycleId, s) => {
      calls.signals.push(s);
      return 99;
    },
    addSignalVotes: async (id, votes) => calls.signalVotes.push({ id, votes }),
    finishCycle: async () => {},
    getAllReliability: async () => reliability,
    getAgentCalibration: async () => calibration,
    getAgentCorrelations: async () => correlations,
    ...(regimeReliability && {
      getRegimeReliability: async (regime) => {
        calls.regimeReads.push(regime);
        return regimeReliability[regime] ?? {};
      },
    }),
    ...(regimeCalibration && {
      getRegimeCalibration: async (regime) => regimeCalibration[regime] ?? {},
    }),
  };
}

const votes = [
  { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1.0, rationale: 't' },
  { agentId: 'news', stance: 2, conviction: 0.9, weight: 1.2, rationale: 'n' },
  { agentId: 'social', stance: 2, conviction: 0.8, weight: 0.8, rationale: 's' },
  { agentId: 'contrarian', stance: 1, conviction: 0.6, weight: 0.9, rationale: 'c' },
];

describe('emitter reliability', () => {
  it('scales vote weights by rho before persisting the forecast snapshot', async () => {
    const bus = createMemoryBus();
    const repo = buildRepo();
    const prices = { NVDA: 120, SPY: 400, QQQ: 300 };
    const gunvest = { getPrice: async (sym) => ({ price: prices[sym] }) };
    createEmitter({
      bus,
      repo,
      telegram: async () => {},
      consensus: { maxRounds: 3, thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 },
      expectedAgents: 4,
      riskEnabled: false,
      gunvest,
      horizonDays: 5,
      clock: () => new Date('2026-06-04T00:00:00Z'),
      logger: { info() {}, error() {} },
    }).start();

    for (const vote of votes) {
      bus.publishJSON(voteSubject('NVDA', 1), { cycleId: 1, symbol: 'NVDA', round: 1, vote });
    }
    await vi.waitFor(() => expect(repo.calls.signals).toHaveLength(1));

    const sig = repo.calls.signals[0];
    expect(sig.entryPrice).toBe(120);
    expect(sig.spyEntryPrice).toBe(400);
    expect(sig.qqqEntryPrice).toBe(300);
    expect(sig.horizonDays).toBe(5);
    expect(new Date(sig.resolveAfter).toISOString()).toBe('2026-06-09T00:00:00.000Z');

    const snap = repo.calls.signalVotes[0];
    expect(snap.id).toBe(99);
    const tech = snap.votes.find((v) => v.agentId === 'technical');
    const news = snap.votes.find((v) => v.agentId === 'news');
    expect(tech.weight).toBeCloseTo(1.5);
    expect(news.weight).toBeCloseTo(0.6);
  });

  it('calibrates conviction for the round record but snapshots raw conviction', async () => {
    const bus = createMemoryBus();
    // technical's conviction is trusted (1.5x), news's is distrusted (0.5x).
    const repo = buildRepo({ calibration: { technical: 1.5, news: 0.5 } });
    const gunvest = { getPrice: async () => ({ price: 120 }) };
    createEmitter({
      bus,
      repo,
      telegram: async () => {},
      consensus: { maxRounds: 3, thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 },
      expectedAgents: 4,
      riskEnabled: false,
      gunvest,
      horizonDays: 5,
      clock: () => new Date('2026-06-04T00:00:00Z'),
      logger: { info() {}, error() {} },
    }).start();

    for (const vote of votes) {
      bus.publishJSON(voteSubject('NVDA', 1), { cycleId: 1, symbol: 'NVDA', round: 1, vote });
    }
    await vi.waitFor(() => expect(repo.calls.signals).toHaveLength(1));

    // Round record stores the effective (calibrated) conviction used in aggregation:
    // technical 0.9*1.5 -> clamped to 1.0; news 0.9*0.5 -> 0.45.
    const techRound = repo.calls.roundVotes.find((v) => v.agentId === 'technical');
    const newsRound = repo.calls.roundVotes.find((v) => v.agentId === 'news');
    expect(techRound.conviction).toBeCloseTo(1.0);
    expect(newsRound.conviction).toBeCloseTo(0.45);

    // Forecast snapshot keeps RAW conviction so the learner is not fed its own output.
    const snap = repo.calls.signalVotes[0].votes;
    expect(snap.find((v) => v.agentId === 'technical').conviction).toBeCloseTo(0.9);
    expect(snap.find((v) => v.agentId === 'news').conviction).toBeCloseTo(0.9);
  });

  it('discounts redundant agreement in the quorum via loaded correlations', async () => {
    const bus = createMemoryBus();
    // All four agents are bullish; without correlation that is a unanimous quorum.
    // Mark every pair as a perfect echo -> the quorum collapses below threshold.
    const ids = ['technical', 'news', 'social', 'contrarian'];
    const correlations = {};
    for (const a of ids) {
      correlations[a] = {};
      for (const b of ids) if (a !== b) correlations[a][b] = 1;
    }
    const repo = buildRepo({ correlations });
    createEmitter({
      bus,
      repo,
      telegram: async () => {},
      consensus: { maxRounds: 1, thetaV: 5, quorum: 2 / 3, holdBand: 0.5 },
      expectedAgents: 4,
      riskEnabled: false,
      gunvest: { getPrice: async () => ({ price: 100 }) },
      clock: () => new Date('2026-06-04T00:00:00Z'),
      logger: { info() {}, error() {} },
    }).start();

    for (const vote of votes) {
      bus.publishJSON(voteSubject('NVDA', 1), { cycleId: 1, symbol: 'NVDA', round: 1, vote });
    }
    await vi.waitFor(() => expect(repo.calls.rounds).toHaveLength(1));

    // High dispersion is allowed (θ_v=5); only the redundancy-discounted quorum gates here.
    expect(repo.calls.rounds[0].kappa).toBeLessThan(2 / 3);
    expect(repo.calls.rounds[0].converged).toBe(false);
    expect(repo.calls.signals[0].band).toBe('NO_CONSENSUS');
  });
});

describe('emitter regime conditioning (ADR 0023)', () => {
  function start({ repo, gunvest }) {
    const bus = createMemoryBus();
    createEmitter({
      bus,
      repo,
      telegram: async () => {},
      consensus: { maxRounds: 3, thetaV: 5, quorum: 0.1, holdBand: 0.5 },
      expectedAgents: 4,
      riskEnabled: false,
      gunvest,
      horizonDays: 5,
      clock: () => new Date('2026-06-04T00:00:00Z'),
      logger: { info() {}, error() {} },
    }).start();
    return bus;
  }

  it('overlays regime dials over the unconditional ones and stamps the signal', async () => {
    const repo = buildRepo({
      reliability: { technical: 1.0 },
      regimeReliability: { stressed: { technical: 1.5 } },
    });
    const gunvest = {
      getPrice: async () => ({ price: 100 }),
      getMacro: async () => ({ vix: 28 }), // stressed
    };
    const bus = start({ repo, gunvest });
    for (const vote of votes) {
      bus.publishJSON(voteSubject('NVDA', 1), { cycleId: 1, symbol: 'NVDA', round: 1, vote });
    }
    await vi.waitFor(() => expect(repo.calls.signals).toHaveLength(1));

    expect(repo.calls.regimeReads).toContain('stressed');
    // technical's snapshot weight reflects the stressed-regime rho, not the global 1.0
    const tech = repo.calls.signalVotes[0].votes.find((v) => v.agentId === 'technical');
    expect(tech.weight).toBeCloseTo(1.5);
    expect(repo.calls.signals[0].regime).toBe('stressed');
  });

  it('falls back to unconditional dials when the regime is unknown', async () => {
    const repo = buildRepo({
      reliability: { technical: 1.2 },
      regimeReliability: { stressed: { technical: 1.5 } },
    });
    const gunvest = { getPrice: async () => ({ price: 100 }) }; // no getMacro -> unknown
    const bus = start({ repo, gunvest });
    for (const vote of votes) {
      bus.publishJSON(voteSubject('NVDA', 1), { cycleId: 1, symbol: 'NVDA', round: 1, vote });
    }
    await vi.waitFor(() => expect(repo.calls.signals).toHaveLength(1));

    expect(repo.calls.regimeReads).toHaveLength(0);
    const tech = repo.calls.signalVotes[0].votes.find((v) => v.agentId === 'technical');
    expect(tech.weight).toBeCloseTo(1.2);
    expect(repo.calls.signals[0].regime).toBe('unknown');
  });
});

describe('emitter herding guard (ADR 0016)', () => {
  const mkVote = (agentId, stance) => ({
    agentId,
    stance,
    conviction: 0.9,
    weight: 1,
    rationale: agentId,
  });
  const consensus = { maxRounds: 2, thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5, priorQuorum: 1 / 3 };

  function run(repo, round1, round2) {
    const bus = createMemoryBus();
    createEmitter({
      bus,
      repo,
      telegram: async () => {},
      consensus,
      expectedAgents: 4,
      riskEnabled: false,
      gunvest: { getPrice: async () => ({ price: 100 }) },
      clock: () => new Date('2026-06-04T00:00:00Z'),
      logger: { info() {}, error() {} },
    }).start();
    const publish = (round, votes) => {
      for (const vote of votes) {
        bus.publishJSON(voteSubject('NVDA', round), { cycleId: 1, symbol: 'NVDA', round, vote });
      }
    };
    return { publish, round1, round2 };
  }

  it('blocks a revision consensus with too little independent backing', async () => {
    const repo = buildRepo({ reliability: {} }); // neutral weights for clean backing math
    // Round 1: a lone bull vs three bears -> no convergence, BUY backing 0.25.
    const round1 = [
      mkVote('technical', 1),
      mkVote('news', -1),
      mkVote('social', -1),
      mkVote('contrarian', -1),
    ];
    // Round 2: everyone flips to BUY -> would converge, but it is a herd.
    const round2 = [
      mkVote('technical', 1),
      mkVote('news', 1),
      mkVote('social', 1),
      mkVote('contrarian', 1),
    ];
    const { publish } = run(repo, round1, round2);

    publish(1, round1);
    await vi.waitFor(() => expect(repo.calls.rounds).toHaveLength(1));
    expect(repo.calls.rounds[0].converged).toBe(false); // split round 1

    publish(2, round2);
    await vi.waitFor(() => expect(repo.calls.signals).toHaveLength(1));
    expect(repo.calls.rounds[1].converged).toBe(false); // herding guard blocked it
    expect(repo.calls.signals[0].band).toBe('NO_CONSENSUS');
  });

  it('allows a revision consensus that retains independent backing', async () => {
    const repo = buildRepo({ reliability: {} }); // neutral weights for clean backing math
    // Round 1: an even 2-2 split (BUY backing 0.5) that does not converge.
    const round1 = [
      mkVote('technical', 1),
      mkVote('news', 1),
      mkVote('social', -1),
      mkVote('contrarian', -1),
    ];
    // Round 2: the two bears come around -> BUY, with 0.5 >= priorQuorum independent backing.
    const round2 = [
      mkVote('technical', 1),
      mkVote('news', 1),
      mkVote('social', 1),
      mkVote('contrarian', 1),
    ];
    const { publish } = run(repo, round1, round2);

    publish(1, round1);
    await vi.waitFor(() => expect(repo.calls.rounds).toHaveLength(1));
    publish(2, round2);
    await vi.waitFor(() => expect(repo.calls.signals).toHaveLength(1));
    expect(repo.calls.rounds[1].converged).toBe(true);
    expect(repo.calls.signals[0].band).toBe('BUY');
  });
});

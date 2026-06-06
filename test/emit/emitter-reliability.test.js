import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createEmitter } from '../../src/emit/emitter.js';
import { voteSubject } from '../../src/bus/subjects.js';

function buildRepo() {
  const calls = { signals: [], signalVotes: [] };
  return {
    calls,
    createCycle: async () => 1,
    addRound: async () => 1,
    addVote: async () => {},
    addSignal: async (_cycleId, s) => {
      calls.signals.push(s);
      return 99;
    },
    addSignalVotes: async (id, votes) => calls.signalVotes.push({ id, votes }),
    finishCycle: async () => {},
    getAllReliability: async () => ({ technical: 1.5, news: 0.5 }),
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

    const sig = repo.calls.signals[0];
    expect(sig.entryPrice).toBe(120);
    expect(sig.horizonDays).toBe(5);
    expect(new Date(sig.resolveAfter).toISOString()).toBe('2026-06-09T00:00:00.000Z');

    const snap = repo.calls.signalVotes[0];
    expect(snap.id).toBe(99);
    const tech = snap.votes.find((v) => v.agentId === 'technical');
    const news = snap.votes.find((v) => v.agentId === 'news');
    expect(tech.weight).toBeCloseTo(1.5);
    expect(news.weight).toBeCloseTo(0.6);
  });
});

import { describe, it, expect } from 'vitest';
import { stanceSeries, threadModel } from '../../src/lib/debate.js';

const rounds = [
  {
    round_no: 1,
    s_score: 0.0,
    dispersion: 1.0,
    quorum: 0.5,
    converged: false,
    votes: [
      { agent_id: 'technical', stance: -1, conviction: 0.6, weight: 1, rationale: 'downtrend' },
      { agent_id: 'contrarian', stance: 1, conviction: 0.8, weight: 1, rationale: 'oversold' },
    ],
  },
  {
    round_no: 2,
    s_score: 1.0,
    dispersion: 0.0,
    quorum: 1.0,
    converged: true,
    votes: [
      { agent_id: 'technical', stance: 1, conviction: 0.7, weight: 1, rationale: 'support held' },
      {
        agent_id: 'contrarian',
        stance: 1,
        conviction: 0.9,
        weight: 1,
        rationale: 'still oversold',
      },
    ],
  },
];

describe('debate derivation', () => {
  it('pivots votes into one stance series per agent across rounds', () => {
    const series = stanceSeries(rounds);
    expect(series.agents).toEqual(['contrarian', 'technical']); // sorted
    expect(series.data).toEqual([
      { round: 1, technical: -1, contrarian: 1 },
      { round: 2, technical: 1, contrarian: 1 },
    ]);
  });

  it('builds a thread model with per-round deltas and prior-round peers', () => {
    const model = threadModel(rounds);
    expect(model[0].roundNo).toBe(1);
    expect(model[0].messages[0].delta).toBeNull();
    expect(model[0].messages[0].peers).toEqual([]);
    const tech2 = model[1].messages.find((m) => m.agentId === 'technical');
    expect(tech2.delta).toBe(2);
    expect(tech2.peers).toContain('contrarian');
  });

  it('surfaces model, source, and derived location per message', () => {
    const rounds = [
      { round_no: 1, votes: [{ agent_id: 'news', stance: 1, conviction: 0.5, rationale: 'r', model: 'gpt-oss:20b', source: 'pc' }] },
    ];
    const [round] = threadModel(rounds);
    expect(round.messages[0]).toMatchObject({ model: 'gpt-oss:20b', source: 'pc', location: 'onprem' });
  });
});

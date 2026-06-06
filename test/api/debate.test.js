import { describe, it, expect, vi } from 'vitest';
import { assembleDebate } from '../../src/api/debate.js';

describe('assembleDebate', () => {
  it('nests rounds and their votes under the cycle', async () => {
    const repo = {
      getCycle: vi.fn(async () => ({ id: 9, symbol: 'NVDA', status: 'converged' })),
      getRounds: vi.fn(async () => [
        { id: 1, round_no: 1, s_score: 0.2, dispersion: 3, quorum: 0.5, converged: false },
        { id: 2, round_no: 2, s_score: 1.6, dispersion: 0.1, quorum: 0.9, converged: true },
      ]),
      getVotes: vi.fn(async (roundId) =>
        roundId === 1
          ? [{ agent_id: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'up' }]
          : [
              {
                agent_id: 'technical',
                stance: 2,
                conviction: 0.9,
                weight: 1,
                rationale: 'still up',
              },
            ],
      ),
    };

    const debate = await assembleDebate(repo, 9);

    expect(debate.id).toBe(9);
    expect(debate.symbol).toBe('NVDA');
    expect(debate.rounds).toHaveLength(2);
    expect(debate.rounds[0].votes[0].agent_id).toBe('technical');
    expect(debate.rounds[1].converged).toBe(true);
    expect(repo.getVotes).toHaveBeenCalledTimes(2);
  });

  it('returns null when the cycle does not exist', async () => {
    const repo = { getCycle: vi.fn(async () => null), getRounds: vi.fn(), getVotes: vi.fn() };
    expect(await assembleDebate(repo, 999)).toBeNull();
    expect(repo.getRounds).not.toHaveBeenCalled();
  });
});

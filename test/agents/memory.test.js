import { describe, it, expect } from 'vitest';
import { formatTrackRecord, buildGetMemory } from '../../src/agents/memory.js';

describe('formatTrackRecord', () => {
  it('is empty when nothing has resolved (cold start parity)', () => {
    expect(formatTrackRecord()).toBe('');
    expect(formatTrackRecord({ overall: { hits: 0, total: 0 }, recent: [] })).toBe('');
  });

  it('renders the overall hit rate and per-call verdicts with alpha', () => {
    const text = formatTrackRecord({
      overall: { hits: 12, total: 20 },
      recent: [
        {
          symbol: 'NVDA',
          stance: 1,
          conviction: 0.8,
          outcome: 0,
          forward_return: -0.021,
          spy_return: 0.01,
        },
        {
          symbol: 'NVDA',
          stance: -1,
          conviction: 0.5,
          outcome: 0,
          forward_return: -0.05,
          spy_return: -0.01,
        },
      ],
    });
    expect(text).toContain('12 of 20 directional calls beat SPY');
    expect(text).toContain('BUY (conviction 0.8) -> missed (-3.1% vs SPY)');
    expect(text).toContain('SELL (conviction 0.5) -> hit (-4.0% vs SPY)');
    expect(text).toContain('Weigh this record honestly');
  });

  it('omits alpha for legacy rows without returns and marks HOLD as no claim', () => {
    const text = formatTrackRecord({
      overall: { hits: 3, total: 5 },
      recent: [
        { symbol: 'MU', stance: 0, conviction: 0.4, outcome: 1 },
        { symbol: 'MU', stance: 2, conviction: 0.9, outcome: 1 },
      ],
    });
    expect(text).toContain('HOLD (conviction 0.4) -> no directional claim');
    expect(text).toContain('STRONG_BUY (conviction 0.9) -> hit');
    expect(text).not.toContain('vs SPY)');
  });
});

describe('buildGetMemory', () => {
  it('formats the repo record for the agent and symbol', async () => {
    const repo = {
      getAgentTrackRecord: async (agentId, symbol) => ({
        overall: { hits: 4, total: 6 },
        recent: [{ symbol, stance: 1, conviction: 0.7, outcome: 1 }],
      }),
    };
    const getMemory = buildGetMemory({ repo, agentId: 'technical' });
    const text = await getMemory({ symbol: 'NVDA' });
    expect(text).toContain('4 of 6');
    expect(text).toContain('NVDA');
  });

  it('degrades to empty when the repo has no track-record support', async () => {
    const getMemory = buildGetMemory({ repo: {}, agentId: 'technical' });
    expect(await getMemory({ symbol: 'NVDA' })).toBe('');
  });

  it('appends the distilled lesson when the reflection pass wrote one (ADR 0026)', async () => {
    const repo = {
      getAgentTrackRecord: async () => ({
        overall: { hits: 4, total: 6 },
        recent: [],
      }),
      getAgentLesson: async () => 'Avoid chasing extended momentum.',
    };
    const getMemory = buildGetMemory({ repo, agentId: 'technical' });
    const text = await getMemory({ symbol: 'NVDA' });
    expect(text).toContain('4 of 6');
    expect(text).toContain(
      'Lesson you drew from your recent misses: Avoid chasing extended momentum.',
    );
  });

  it('surfaces a lesson even before the track record has resolved entries', async () => {
    const repo = {
      getAgentTrackRecord: async () => ({ overall: { hits: 0, total: 0 }, recent: [] }),
      getAgentLesson: async () => 'Lean on positioning data, not vibes.',
    };
    const getMemory = buildGetMemory({ repo, agentId: 'contrarian' });
    expect(await getMemory({ symbol: 'MU' })).toBe(
      'Lesson you drew from your recent misses: Lean on positioning data, not vibes.',
    );
  });
});

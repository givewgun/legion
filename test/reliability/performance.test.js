import { describe, it, expect } from 'vitest';
import { summarizeAgents } from '../../src/reliability/performance.js';
import { modelKey } from '../../src/llm/provider.js';

// Helpers to build minimal row objects (signal_votes ⋈ signals, newest-first).
const row = (
  agentId,
  {
    stance = 1,
    conviction = 0.5,
    outcome = 1,
    forwardReturn = null,
    spyReturn = null,
    model = undefined,
  } = {},
) => ({
  agent_id: agentId,
  model,
  stance,
  conviction,
  outcome,
  forward_return: forwardReturn,
  spy_return: spyReturn,
});

// Summaries are keyed per (agent, model) — the same composite key the dials use.
const get = (map, agentId, model = undefined) => map.get(modelKey(agentId, model));

describe('summarizeAgents', () => {
  it('returns an empty Map when given no rows', () => {
    const result = summarizeAgents([], { window: 50 });
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('counts wins and losses for directional calls', () => {
    const rows = [
      row('a', { stance: 1, outcome: 1 }), // bullish, beat SPY → win
      row('a', { stance: 1, outcome: 0 }), // bullish, lagged SPY → loss
      row('a', { stance: -1, outcome: 0 }), // bearish, lagged SPY → win
      row('a', { stance: -1, outcome: 1 }), // bearish, beat SPY → loss
    ];
    const map = summarizeAgents(rows, { window: 50 });
    const s = get(map, 'a');
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.holds).toBe(0);
  });

  it('counts holds (stance === 0) separately, not as wins or losses', () => {
    const rows = [
      row('a', { stance: 0, outcome: 1 }),
      row('a', { stance: 0, outcome: 0 }),
      row('a', { stance: 1, outcome: 1 }),
    ];
    const map = summarizeAgents(rows, { window: 50 });
    const s = get(map, 'a');
    expect(s.holds).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(0);
  });

  it('hitRate = wins / (wins + losses); null when no directional calls', () => {
    // All holds → null hitRate
    const allHolds = [row('a', { stance: 0 }), row('a', { stance: 0 })];
    const mapHolds = summarizeAgents(allHolds, { window: 50 });
    expect(get(mapHolds, 'a').hitRate).toBeNull();

    // 3 wins, 1 loss → 0.75
    const mixed = [
      row('b', { stance: 1, outcome: 1 }),
      row('b', { stance: 1, outcome: 1 }),
      row('b', { stance: 1, outcome: 1 }),
      row('b', { stance: 1, outcome: 0 }),
    ];
    const mapMixed = summarizeAgents(mixed, { window: 50 });
    expect(get(mapMixed, 'b').hitRate).toBeCloseTo(0.75);
  });

  it('avgAlpha = mean(forward_return - spy_return) over directional calls with both returns present', () => {
    const rows = [
      row('a', { stance: 1, outcome: 1, forwardReturn: 0.1, spyReturn: 0.02 }), // alpha 0.08
      row('a', { stance: -1, outcome: 0, forwardReturn: -0.05, spyReturn: 0.01 }), // alpha -0.06
    ];
    const map = summarizeAgents(rows, { window: 50 });
    const s = get(map, 'a');
    // (0.08 + -0.06) / 2 = 0.01
    expect(s.avgAlpha).toBeCloseTo(0.01);
  });

  it('bestAlpha and worstAlpha are the max and min individual call alphas', () => {
    const rows = [
      row('a', { stance: 1, outcome: 1, forwardReturn: 0.1, spyReturn: 0.01 }), // 0.09
      row('a', { stance: 1, outcome: 1, forwardReturn: 0.02, spyReturn: 0.01 }), // 0.01
      row('a', { stance: 1, outcome: 0, forwardReturn: -0.05, spyReturn: 0.01 }), // -0.06
    ];
    const map = summarizeAgents(rows, { window: 50 });
    const s = get(map, 'a');
    expect(s.bestAlpha).toBeCloseTo(0.09);
    expect(s.worstAlpha).toBeCloseTo(-0.06);
  });

  it('avgAlpha/bestAlpha/worstAlpha are null when no directional calls have both returns', () => {
    // All holds
    const rows = [row('a', { stance: 0, forwardReturn: 0.05, spyReturn: 0.01 })];
    const map = summarizeAgents(rows, { window: 50 });
    const s = get(map, 'a');
    expect(s.avgAlpha).toBeNull();
    expect(s.bestAlpha).toBeNull();
    expect(s.worstAlpha).toBeNull();
  });

  it('null forward_return or spy_return excludes call from alpha math but counts for W/L', () => {
    const rows = [
      row('a', { stance: 1, outcome: 1, forwardReturn: null, spyReturn: null }), // win, no alpha
      row('a', { stance: 1, outcome: 0, forwardReturn: null, spyReturn: null }), // loss, no alpha
      row('a', { stance: 1, outcome: 1, forwardReturn: 0.05, spyReturn: 0.01 }), // win, alpha 0.04
    ];
    const map = summarizeAgents(rows, { window: 50 });
    const s = get(map, 'a');
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    // avgAlpha only over the one row with valid returns
    expect(s.avgAlpha).toBeCloseTo(0.04);
    expect(s.bestAlpha).toBeCloseTo(0.04);
    expect(s.worstAlpha).toBeCloseTo(0.04);
  });

  it('respects the window cap — only newest `window` rows per agent', () => {
    // 55 rows for agent 'a'. First 50 in array = newest (rows are newest-first).
    // Wins come from positions 0-49; position 50-54 are losses that should be excluded.
    const winRow = row('a', { stance: 1, outcome: 1 });
    const lossRow = row('a', { stance: 1, outcome: 0 });
    const rows = [
      ...Array.from({ length: 50 }, () => winRow),
      ...Array.from({ length: 5 }, () => lossRow),
    ];
    const map = summarizeAgents(rows, { window: 50 });
    const s = get(map, 'a');
    expect(s.wins).toBe(50);
    expect(s.losses).toBe(0);
    expect(s.sample).toBe(50);
  });

  it('handles multiple agents independently', () => {
    const rows = [
      row('alpha', { stance: 1, outcome: 1 }),
      row('alpha', { stance: 1, outcome: 1 }),
      row('beta', { stance: -1, outcome: 1 }), // bearish, beat SPY → loss
      row('beta', { stance: -1, outcome: 0 }), // bearish, lagged → win
    ];
    const map = summarizeAgents(rows, { window: 50 });
    expect(get(map, 'alpha').wins).toBe(2);
    expect(get(map, 'alpha').losses).toBe(0);
    expect(get(map, 'beta').wins).toBe(1);
    expect(get(map, 'beta').losses).toBe(1);
  });

  it('recent list is newest-first, capped at 10, and carries correct win/alpha fields', () => {
    // 15 rows for agent 'a' — newest first in array
    const rows = Array.from({ length: 15 }, (_, i) => ({
      agent_id: 'a',
      stance: 1,
      conviction: 0.8,
      outcome: 1,
      forward_return: 0.05 + i * 0.001,
      spy_return: 0.01,
      symbol: `SYM${i}`,
    }));
    const map = summarizeAgents(rows, { window: 50 });
    const s = get(map, 'a');
    expect(s.recent).toHaveLength(10);
    // First in recent = index 0 (newest)
    expect(s.recent[0].symbol).toBe('SYM0');
    expect(s.recent[0].win).toBe(true);
    expect(typeof s.recent[0].alpha).toBe('number');
  });

  it('win field in recent is null for holds', () => {
    const rows = [
      {
        agent_id: 'a',
        stance: 0,
        conviction: 0.5,
        outcome: 1,
        forward_return: null,
        spy_return: null,
        symbol: 'X',
      },
    ];
    const map = summarizeAgents(rows, { window: 50 });
    expect(get(map, 'a').recent[0].win).toBeNull();
  });

  it('alpha field in recent is null when returns are missing', () => {
    const rows = [
      {
        agent_id: 'a',
        stance: 1,
        conviction: 0.5,
        outcome: 1,
        forward_return: null,
        spy_return: null,
        symbol: 'X',
      },
    ];
    const map = summarizeAgents(rows, { window: 50 });
    expect(get(map, 'a').recent[0].alpha).toBeNull();
  });

  it('segments one agent per model — each model earns its own record', () => {
    const rows = [
      row('a', { stance: 1, outcome: 1, model: 'qwen3:8b' }), // win on the PC model
      row('a', { stance: 1, outcome: 1, model: 'qwen3:8b' }), // win on the PC model
      row('a', { stance: 1, outcome: 0, model: 'qwen2.5:3b-instruct' }), // loss on Oracle
    ];
    const map = summarizeAgents(rows, { window: 50 });
    expect(get(map, 'a', 'qwen3:8b').wins).toBe(2);
    expect(get(map, 'a', 'qwen3:8b').losses).toBe(0);
    expect(get(map, 'a', 'qwen2.5:3b-instruct').wins).toBe(0);
    expect(get(map, 'a', 'qwen2.5:3b-instruct').losses).toBe(1);
    expect(get(map, 'a')).toBeUndefined(); // no blended bucket
  });

  it('sample field reflects actual rows used (respects window cap)', () => {
    const rows = Array.from({ length: 30 }, () => row('a', { stance: 1, outcome: 1 }));
    const map = summarizeAgents(rows, { window: 50 });
    expect(get(map, 'a').sample).toBe(30);
  });
});

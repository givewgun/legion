import { describe, it, expect } from 'vitest';
import { pearson, pairwiseCorrelations } from '../../src/consensus/correlation.js';

describe('pearson', () => {
  it('is +1 for a perfectly increasing relationship', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });
  it('is -1 for a perfectly inverse relationship', () => {
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1);
  });
  it('is null with fewer than two points', () => {
    expect(pearson([1], [2])).toBeNull();
  });
  it('is null when a series has zero variance', () => {
    expect(pearson([2, 2, 2], [1, 2, 3])).toBeNull();
  });
});

describe('pairwiseCorrelations', () => {
  // 6 signals: a & b always agree (corr +1); a & c always oppose (corr -1).
  const rows = [];
  for (let signal = 1; signal <= 6; signal += 1) {
    const stance = signal % 2 === 0 ? 2 : 1;
    rows.push({ signal_id: signal, agent_id: 'a', stance });
    rows.push({ signal_id: signal, agent_id: 'b', stance });
    rows.push({ signal_id: signal, agent_id: 'c', stance: -stance });
  }

  it('finds co-moving and opposing pairs', () => {
    const out = pairwiseCorrelations(rows);
    const get = (x, y) => out.find((p) => p.a === x && p.b === y);
    expect(get('a', 'b').corr).toBeCloseTo(1);
    expect(get('a', 'c').corr).toBeCloseTo(-1);
    expect(get('a', 'b').n).toBe(6);
  });

  it('excludes pairs below the minimum co-rated sample', () => {
    const sparse = [
      { signal_id: 1, agent_id: 'a', stance: 1 },
      { signal_id: 1, agent_id: 'd', stance: 1 },
      { signal_id: 2, agent_id: 'a', stance: 2 },
      { signal_id: 2, agent_id: 'd', stance: 2 },
    ];
    expect(pairwiseCorrelations(sparse)).toHaveLength(0); // only 2 common signals < MIN_CORR_PAIRS
  });

  it('omits a pair whose correlation is undefined (constant stance)', () => {
    const flat = Array.from({ length: 6 }, (_, i) => i + 1).flatMap((signal) => [
      { signal_id: signal, agent_id: 'a', stance: 1 }, // a never varies
      { signal_id: signal, agent_id: 'b', stance: signal % 2 === 0 ? 2 : 1 },
    ]);
    expect(pairwiseCorrelations(flat)).toHaveLength(0);
  });
});

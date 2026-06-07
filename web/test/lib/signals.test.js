import { describe, it, expect } from 'vitest';
import { summarize, sortSignals } from '../../src/lib/signals.js';

const rows = [
  {
    id: 1,
    symbol: 'NVDA',
    band: 'STRONG_BUY',
    conviction: 0.8,
    created_at: '2026-06-03T10:00:00Z',
  },
  { id: 2, symbol: 'TSLA', band: 'SELL', conviction: 0.5, created_at: '2026-06-03T11:00:00Z' },
  { id: 3, symbol: 'MSFT', band: 'HOLD', conviction: 0.2, created_at: '2026-06-03T12:00:00Z' },
];

describe('signal helpers', () => {
  it('summarizes counts, bull/bear split and average conviction', () => {
    const s = summarize(rows);
    expect(s.total).toBe(3);
    expect(s.bull).toBe(1); // STRONG_BUY/BUY
    expect(s.bear).toBe(1); // SELL/STRONG_SELL
    expect(s.avgConviction).toBeCloseTo(0.5, 5);
    expect(s.lastCreatedAt).toBe('2026-06-03T12:00:00Z');
  });

  it('summarizes empty input safely', () => {
    expect(summarize([])).toEqual({
      total: 0,
      bull: 0,
      bear: 0,
      avgConviction: 0,
      lastCreatedAt: null,
    });
  });

  it('sorts by a column ascending and descending', () => {
    expect(sortSignals(rows, 'conviction', 'desc').map((r) => r.id)).toEqual([1, 2, 3]);
    expect(sortSignals(rows, 'conviction', 'asc').map((r) => r.id)).toEqual([3, 2, 1]);
    expect(sortSignals(rows, 'symbol', 'asc').map((r) => r.symbol)).toEqual([
      'MSFT',
      'NVDA',
      'TSLA',
    ]);
  });
});

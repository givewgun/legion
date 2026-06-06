import { describe, it, expect } from 'vitest';
import { runBacktest } from '../../src/backtest/deterministic.js';

function series(prices, startDay = 1) {
  return prices.map((p, i) => ({
    date: `2026-06-${String(startDay + i).padStart(2, '0')}`,
    close: p,
  }));
}

describe('runBacktest', () => {
  it('returns zeroed result when history is too short to ever signal', () => {
    const candles = series([100, 101, 102]);
    const r = runBacktest(candles, candles, candles, { horizon: 2 });
    expect(r.trades).toBe(0);
    expect(r.hitRate).toBe(0);
    expect(r.pnl).toBe(0);
  });

  it('long trade on an uptrend is a profitable hit', () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100 + i);
    const candles = prices.map((p, i) => ({ date: `d${String(i).padStart(3, '0')}`, close: p }));
    const flatBench = candles.map((c) => ({ date: c.date, close: 400 }));
    const r = runBacktest(candles, flatBench, flatBench, { horizon: 3 });
    expect(r.trades).toBeGreaterThan(0);
    expect(r.hits).toBe(r.trades);
    expect(r.hitRate).toBeCloseTo(1.0);
    expect(r.pnl).toBeGreaterThan(0);
    expect(r.spyPnl).toBeCloseTo(0);
  });

  it('hitRate is hits/trades', () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100 + i);
    const candles = prices.map((p, i) => ({ date: `d${String(i).padStart(3, '0')}`, close: p }));
    const r = runBacktest(candles, candles, candles, { horizon: 3 });
    if (r.trades > 0) expect(r.hitRate).toBeCloseTo(r.hits / r.trades);
  });
});

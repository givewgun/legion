import { describe, it, expect } from 'vitest';
import { computeIndicators } from '../../../src/agents/technical/indicators.js';

// Strictly increasing closes 1..50: every daily change is a gain, so RSI = 100
// and the moving averages / returns are hand-computable.
const rising = Array.from({ length: 50 }, (_, i) => ({
  date: `2026-01-${i + 1}`,
  close: i + 1,
}));

describe('computeIndicators', () => {
  it('computes SMAs over the trailing window', () => {
    const ind = computeIndicators(rising);
    expect(ind.sma20).toBeCloseTo(40.5, 5); // mean of 31..50
    expect(ind.sma50).toBeCloseTo(25.5, 5); // mean of 1..50
    expect(ind.sma200).toBeUndefined(); // only 50 samples
  });

  it('reports RSI 100 for a monotonically rising series', () => {
    expect(computeIndicators(rising).rsi14).toBe(100);
  });

  it('computes trailing returns from the latest close', () => {
    // latest = 50, close 21 sessions back = 29 → (50/29 - 1) * 100
    expect(computeIndicators(rising).return1m).toBeCloseTo((50 / 29 - 1) * 100, 4);
  });

  it('derives 52-week high/low and distance from them', () => {
    const ind = computeIndicators(rising);
    expect(ind.fiftyTwoWeekHigh).toBe(50);
    expect(ind.fiftyTwoWeekLow).toBe(1);
    expect(ind.pctFromHigh).toBeCloseTo(0, 5);
    expect(ind.pctFromLow).toBeCloseTo(4900, 1);
  });

  it('reports a finite positive volatility', () => {
    expect(computeIndicators(rising).volatility).toBeGreaterThan(0);
  });

  it('accepts a bare array of numbers', () => {
    expect(computeIndicators([10, 11, 12, 13]).latestClose).toBe(13);
  });

  it('omits indicators it cannot compute on short history without throwing', () => {
    const ind = computeIndicators([{ close: 10 }, { close: 11 }, { close: 12 }]);
    expect(ind.sma20).toBeUndefined();
    expect(ind.rsi14).toBeUndefined();
    expect(ind.latestClose).toBe(12);
  });

  it('returns an empty object for empty or garbage input', () => {
    expect(computeIndicators([])).toEqual({});
    expect(computeIndicators(null)).toEqual({});
    expect(computeIndicators(undefined)).toEqual({});
  });
});

import { describe, it, expect } from 'vitest';
import { sma, rsi, macd, computeIndicators, quantStance } from '../../src/backtest/indicators.js';

const up = Array.from({ length: 60 }, (_, i) => 100 + i);
const down = Array.from({ length: 60 }, (_, i) => 160 - i);

describe('sma', () => {
  it('averages the last N', () => {
    expect(sma([1, 2, 3, 4], 2)).toBeCloseTo(3.5);
  });
  it('returns null when too short', () => {
    expect(sma([1], 2)).toBeNull();
  });
});

describe('rsi', () => {
  it('is ~100 for a strictly rising series', () => {
    expect(rsi(up, 14)).toBeGreaterThan(95);
  });
  it('is ~0 for a strictly falling series', () => {
    expect(rsi(down, 14)).toBeLessThan(5);
  });
});

describe('macd', () => {
  it('is positive when fast EMA leads on an uptrend', () => {
    const { macd: line, signal } = macd(up);
    expect(line).toBeGreaterThanOrEqual(signal - 1e-10);
  });
});

describe('quantStance', () => {
  it('strong buy when trend up + momentum up', () => {
    expect(quantStance({ sma20: 120, sma50: 110, macd: 2, signal: 1, rsi: 55 })).toBe(2);
  });
  it('strong sell when trend down + momentum down', () => {
    expect(quantStance({ sma20: 100, sma50: 110, macd: -2, signal: -1, rsi: 45 })).toBe(-2);
  });
  it('HOLD on mixed signals', () => {
    expect(quantStance({ sma20: 110, sma50: 110, macd: 1, signal: 1, rsi: 50 })).toBe(0);
  });
  it('returns HOLD when indicators are null (insufficient data)', () => {
    expect(quantStance({ sma20: null, sma50: null, macd: null, signal: null, rsi: null })).toBe(0);
  });
});

describe('computeIndicators', () => {
  it('produces non-null indicators given enough history', () => {
    const ind = computeIndicators(up);
    expect(ind.sma20).not.toBeNull();
    expect(ind.sma50).not.toBeNull();
    expect(ind.rsi).not.toBeNull();
  });
  it('nulls long-window indicators when history is short', () => {
    const ind = computeIndicators([100, 101, 102]);
    expect(ind.sma50).toBeNull();
  });
});

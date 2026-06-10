import { describe, it, expect } from 'vitest';
import { simulatePortfolio } from '../../src/portfolio/simulate.js';

// Fixture helpers: a synthetic trading calendar of consecutive January days.
const day = (n) => `2026-01-${String(n).padStart(2, '0')}`;
const series = (closes) => closes.map((close, i) => ({ date: day(i + 1), close }));
const flat = (price, n) => series(Array(n).fill(price));

const signal = (symbol, band, dayN, conviction = 1) => ({
  symbol,
  band,
  conviction: String(conviction), // NUMERIC arrives as a string from pg
  created_at: `${day(dayN)}T14:30:00Z`,
});

describe('simulatePortfolio', () => {
  it('opens a conviction-sized long and exits after horizonDays trading days', () => {
    const nvda = series([100, 100, 100, 100, 100, 110, 110, 110, 110, 110]);
    const r = simulatePortfolio(
      [signal('NVDA', 'BUY', 1, 1)],
      { NVDA: nvda },
      flat(100, 10),
      flat(100, 10),
    );
    // 10% of 100k = 10k at $100 → 100 shares; horizon exit on day 6 at $110.
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.shares).toBeCloseTo(100);
    expect(t.entryDate).toBe(day(1));
    expect(t.exitDate).toBe(day(6));
    expect(t.exitPrice).toBe(110);
    expect(t.return).toBeCloseTo(0.1);
    expect(t.exitReason).toBe('horizon');
    expect(r.stats.totalReturn).toBeCloseTo(0.01);
    expect(r.stats.winRate).toBe(1);
  });

  it('closes early on a SELL signal for the same symbol', () => {
    const nvda = series([100, 100, 105, 105, 105, 105, 105, 105, 105, 105]);
    const r = simulatePortfolio(
      [signal('NVDA', 'BUY', 1), signal('NVDA', 'SELL', 3)],
      { NVDA: nvda },
      flat(100, 10),
      flat(100, 10),
    );
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitDate).toBe(day(3));
    expect(r.trades[0].exitReason).toBe('sell-signal');
    expect(r.trades[0].return).toBeCloseTo(0.05);
  });

  it('does not pyramid an already-open symbol', () => {
    const r = simulatePortfolio(
      [signal('NVDA', 'BUY', 1), signal('NVDA', 'STRONG_BUY', 2)],
      { NVDA: flat(100, 10) },
      flat(100, 10),
      flat(100, 10),
    );
    expect(r.trades).toHaveLength(1);
  });

  it('caps a position at available cash', () => {
    // maxPositionFraction 1 + conviction 1 → first buy consumes all cash; the
    // second symbol has nothing left to buy with.
    const r = simulatePortfolio(
      [signal('NVDA', 'BUY', 1), signal('MSFT', 'BUY', 1)],
      { NVDA: flat(100, 10), MSFT: flat(50, 10) },
      flat(100, 10),
      flat(100, 10),
      { maxPositionFraction: 1 },
    );
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].symbol).toBe('NVDA');
  });

  it('ignores HOLD, NO_CONSENSUS, and zero-conviction signals', () => {
    const r = simulatePortfolio(
      [
        signal('NVDA', 'HOLD', 1),
        signal('NVDA', 'NO_CONSENSUS', 2, 0),
        signal('NVDA', 'BUY', 3, 0),
      ],
      { NVDA: flat(100, 10) },
      flat(100, 10),
      flat(100, 10),
    );
    expect(r.trades).toHaveLength(0);
    // The curve still starts at the first signal's day (flat cash).
    expect(r.curve[0]).toMatchObject({ date: day(1), equity: 100_000 });
  });

  it('counts a buy with no candle data as skipped', () => {
    const r = simulatePortfolio(
      [signal('NVDA', 'BUY', 1)],
      { NVDA: [] },
      flat(100, 10),
      flat(100, 10),
    );
    expect(r.trades).toHaveLength(0);
    expect(r.stats.skipped).toBe(1);
  });

  it('tracks SPY and QQQ buy-and-hold benchmarks from the first signal day', () => {
    const r = simulatePortfolio(
      [signal('NVDA', 'HOLD', 1)],
      { NVDA: flat(100, 3) },
      series([100, 105, 110]),
      series([200, 220, 240]),
    );
    expect(r.curve.map((p) => p.spy)).toEqual([100_000, 105_000, 110_000]);
    expect(r.curve.map((p) => p.qqq)).toEqual([100_000, 110_000, 120_000]);
    expect(r.stats.spyReturn).toBeCloseTo(0.1);
    expect(r.stats.qqqReturn).toBeCloseTo(0.2);
  });

  it('returns empty results for no signals', () => {
    const r = simulatePortfolio([], {}, flat(100, 10), flat(100, 10));
    expect(r.curve).toEqual([]);
    expect(r.trades).toEqual([]);
    expect(r.stats.totalReturn).toBe(0);
    expect(r.stats.trades).toBe(0);
  });

  it('leaves a position open at the end of the calendar with unrealized return', () => {
    const nvda = series([100, 120, 90]);
    const r = simulatePortfolio(
      [signal('NVDA', 'BUY', 1)],
      { NVDA: nvda },
      flat(100, 3),
      flat(100, 3),
      { maxPositionFraction: 1 },
    );
    expect(r.trades[0].exitReason).toBe('open');
    expect(r.trades[0].exitDate).toBeNull();
    expect(r.trades[0].return).toBeCloseTo(-0.1);
    // Equity 100k → 120k → 90k: max drawdown (120k-90k)/120k = 0.25.
    expect(r.stats.maxDrawdown).toBeCloseTo(0.25);
    // Open trades don't count toward win rate.
    expect(r.stats.winRate).toBe(0);
  });
});

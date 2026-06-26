import { describe, it, expect } from 'vitest';
import { buildPaperBook } from '../../src/portfolio/paper-book.js';

// 6-day trading calendar; SPY rises 100→150, QQQ flat at 100.
const spy = [
  { date: '2026-01-01', close: 100 },
  { date: '2026-01-02', close: 110 },
  { date: '2026-01-03', close: 120 },
  { date: '2026-01-04', close: 130 },
  { date: '2026-01-05', close: 140 },
  { date: '2026-01-06', close: 150 },
];
const qqq = spy.map((c) => ({ date: c.date, close: 100 }));
const opts = { startingCapital: 10000, horizonDays: 5, baseWeight: 0.05, maxPerName: 0.2 };

const sig = (o) => ({ band: 'BUY', conviction: 1, plan: { qualityMult: 1 }, ...o });

describe('buildPaperBook', () => {
  it('enters at the captured entry_price, not the candle close', () => {
    const signals = [sig({ symbol: 'NVDA', entry_price: 50, created_at: '2026-01-01T00:00:00Z' })];
    const candlesBySymbol = { NVDA: spy.map((c) => ({ date: c.date, close: 200 })) };
    const { trades } = buildPaperBook(signals, { candlesBySymbol, spy, qqq, livePrices: {} }, opts);
    expect(trades[0].entryPrice).toBe(50); // not the 200 candle close
  });

  it('weights position size by conviction × qualityMult', () => {
    const candlesBySymbol = { A: spy.map((c) => ({ date: c.date, close: 10 })) };
    const mk = (q) =>
      buildPaperBook(
        [sig({ symbol: 'A', entry_price: 10, plan: { qualityMult: q }, created_at: '2026-01-01T00:00:00Z' })],
        { candlesBySymbol, spy, qqq, livePrices: {} },
        opts,
      );
    expect(mk(1.5).trades[0].shares).toBeGreaterThan(mk(0.5).trades[0].shares);
  });

  it('produces a daily equity curve with SPY and QQQ series', () => {
    const signals = [sig({ symbol: 'NVDA', entry_price: 50, created_at: '2026-01-01T00:00:00Z' })];
    const candlesBySymbol = { NVDA: spy.map((c) => ({ date: c.date, close: 50 })) };
    const { curve, stats } = buildPaperBook(signals, { candlesBySymbol, spy, qqq, livePrices: {} }, opts);
    expect(curve.length).toBeGreaterThan(1);
    expect(curve[0]).toHaveProperty('spy');
    expect(curve[0]).toHaveProperty('qqq');
    // SPY ran 100→150 from the first trade day → +50%.
    expect(stats.spyReturn).toBeCloseTo(0.5, 5);
    expect(stats.qqqReturn).toBeCloseTo(0, 5);
  });

  it('closes on a SELL signal at that day candle close', () => {
    const signals = [
      sig({ symbol: 'NVDA', entry_price: 50, created_at: '2026-01-01T00:00:00Z' }),
      sig({ symbol: 'NVDA', band: 'SELL', created_at: '2026-01-03T00:00:00Z' }),
    ];
    const candlesBySymbol = {
      NVDA: [
        { date: '2026-01-01', close: 50 }, { date: '2026-01-02', close: 55 },
        { date: '2026-01-03', close: 60 }, { date: '2026-01-04', close: 65 },
        { date: '2026-01-05', close: 70 }, { date: '2026-01-06', close: 75 },
      ],
    };
    const { trades, openPositions } = buildPaperBook(signals, { candlesBySymbol, spy, qqq, livePrices: {} }, opts);
    expect(trades[0].exitReason).toBe('sell-signal');
    expect(trades[0].exitPrice).toBe(60);
    expect(openPositions).toHaveLength(0);
  });

  it('horizon-exits horizonDays trading days after entry', () => {
    const signals = [sig({ symbol: 'NVDA', entry_price: 50, created_at: '2026-01-01T00:00:00Z' })];
    const candlesBySymbol = { NVDA: spy.map((c) => ({ date: c.date, close: 50 })) };
    const { trades } = buildPaperBook(signals, { candlesBySymbol, spy, qqq, livePrices: {} }, { ...opts, horizonDays: 3 });
    expect(trades[0].exitReason).toBe('horizon');
    expect(trades[0].exitDate).toBe('2026-01-04'); // entry idx 0 + 3 trading days
  });

  it('does not pyramid: a second BUY for an open symbol is skipped', () => {
    const signals = [
      sig({ symbol: 'NVDA', entry_price: 50, created_at: '2026-01-01T00:00:00Z' }),
      sig({ symbol: 'NVDA', entry_price: 60, created_at: '2026-01-02T00:00:00Z' }),
    ];
    const candlesBySymbol = { NVDA: spy.map((c) => ({ date: c.date, close: 50 })) };
    const { trades } = buildPaperBook(signals, { candlesBySymbol, spy, qqq, livePrices: {} }, opts);
    expect(trades.filter((t) => t.symbol === 'NVDA')).toHaveLength(1);
  });

  it('marks still-open positions at the live price for the panel', () => {
    const signals = [sig({ symbol: 'NVDA', entry_price: 50, created_at: '2026-01-06T00:00:00Z' })];
    const candlesBySymbol = { NVDA: spy.map((c) => ({ date: c.date, close: 50 })) };
    const { openPositions } = buildPaperBook(signals, { candlesBySymbol, spy, qqq, livePrices: { NVDA: 75 } }, opts);
    expect(openPositions[0].markPrice).toBe(75);
    expect(openPositions[0].unrealizedReturn).toBeCloseTo(0.5, 5);
  });

  it('returns empty results when no signals fall on the calendar', () => {
    const { curve, trades, openPositions, stats } = buildPaperBook([], { candlesBySymbol: {}, spy, qqq, livePrices: {} }, opts);
    expect(curve).toEqual([]);
    expect(trades).toEqual([]);
    expect(openPositions).toEqual([]);
    expect(stats.totalReturn).toBe(0);
  });
});

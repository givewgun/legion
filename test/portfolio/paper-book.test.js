import { describe, it, expect } from 'vitest';
import { buildPaperBook } from '../../src/portfolio/paper-book.js';

const sig = (o) => ({ band: 'BUY', conviction: 1, plan: { qualityMult: 1 }, spy_entry_price: 100, qqq_entry_price: 100, ...o });

describe('buildPaperBook', () => {
  it('enters at the captured entry_price, not a later close', () => {
    const signals = [sig({ symbol: 'NVDA', entry_price: 50, created_at: '2026-01-01T15:00:00Z', resolve_after: '2026-12-01T00:00:00Z' })];
    const { trades } = buildPaperBook(signals, { NVDA: 75, SPY: 110, QQQ: 110 }, { startingCapital: 10000, horizonDays: 5, baseWeight: 0.05, maxPerName: 0.1 });
    expect(trades[0].entryPrice).toBe(50);
  });

  it('weights the position by conviction × qualityMult', () => {
    const hi = buildPaperBook([sig({ symbol: 'A', entry_price: 10, plan: { qualityMult: 1.5 }, created_at: '2026-01-01T00:00:00Z', resolve_after: '2026-12-01T00:00:00Z' })], { A: 10, SPY: 100, QQQ: 100 }, { startingCapital: 10000, horizonDays: 5, baseWeight: 0.05, maxPerName: 0.2 });
    const lo = buildPaperBook([sig({ symbol: 'A', entry_price: 10, plan: { qualityMult: 0.5 }, created_at: '2026-01-01T00:00:00Z', resolve_after: '2026-12-01T00:00:00Z' })], { A: 10, SPY: 100, QQQ: 100 }, { startingCapital: 10000, horizonDays: 5, baseWeight: 0.05, maxPerName: 0.2 });
    expect(hi.trades[0].shares).toBeGreaterThan(lo.trades[0].shares);
  });

  it('marks an open position to the live price', () => {
    const { openPositions } = buildPaperBook([sig({ symbol: 'NVDA', entry_price: 50, created_at: '2026-01-01T00:00:00Z', resolve_after: '2099-01-01T00:00:00Z' })], { NVDA: 75, SPY: 100, QQQ: 100 }, { startingCapital: 10000, horizonDays: 5, baseWeight: 0.05, maxPerName: 0.2 });
    expect(openPositions[0].markPrice).toBe(75);
    expect(openPositions[0].unrealizedReturn).toBeCloseTo(0.5, 5);
  });

  it('closes on a SELL signal', () => {
    const signals = [
      sig({ symbol: 'NVDA', entry_price: 50, created_at: '2026-01-01T00:00:00Z', resolve_after: '2099-01-01T00:00:00Z' }),
      sig({ symbol: 'NVDA', band: 'SELL', entry_price: 60, created_at: '2026-02-01T00:00:00Z', resolve_after: '2099-01-01T00:00:00Z' }),
    ];
    const { openPositions, trades } = buildPaperBook(signals, { NVDA: 75, SPY: 100, QQQ: 100 }, { startingCapital: 10000, horizonDays: 5, baseWeight: 0.05, maxPerName: 0.2 });
    expect(openPositions).toHaveLength(0);
    expect(trades[0].exitReason).toBe('sell-signal');
    expect(trades[0].exitPrice).toBe(60);
  });
});

import { describe, it, expect } from 'vitest';
import { computeSizing, buildSizingBook } from '../../src/sizing/engine.js';

const config = { baseWeight: 0.05, maxPerName: 0.10, rebalanceBandPct: 0.01 };

describe('computeSizing', () => {
  it('targets baseWeight × conviction × qualityMult, clamped to maxPerName', () => {
    const row = computeSizing({
      signal: { symbol: 'NVDA', band: 'STRONG_BUY', conviction: 1 },
      qualityMult: 1.5, position: { shares: 0, avgCost: 0 },
      livePrice: 100, portfolioValue: 10000, config,
    });
    // 0.05 × 1 × 1.5 = 0.075 < 0.10 cap
    expect(row.targetWeight).toBeCloseTo(0.075, 5);
    expect(row.action).toBe('buy');
    expect(row.deltaUSD).toBeCloseTo(750, 5);
    expect(row.deltaShares).toBeCloseTo(7.5, 5);
  });

  it('clamps to maxPerName', () => {
    const row = computeSizing({
      signal: { symbol: 'NVDA', band: 'STRONG_BUY', conviction: 1 },
      qualityMult: 1.5, position: { shares: 0, avgCost: 0 },
      livePrice: 100, portfolioValue: 10000, config: { ...config, baseWeight: 0.1 },
    });
    expect(row.targetWeight).toBe(0.10);
  });

  it('SELL / NO_CONSENSUS / missing signal → target 0 and trim', () => {
    for (const signal of [{ symbol: 'X', band: 'SELL', conviction: 1 }, { symbol: 'X', band: 'NO_CONSENSUS', conviction: 0 }, null]) {
      const row = computeSizing({ signal, qualityMult: 1.5, position: { shares: 10, avgCost: 5 }, livePrice: 10, portfolioValue: 1000, config });
      expect(row.targetWeight).toBe(0);
      expect(row.action).toBe('trim');
    }
  });

  it('computes unrealized P/L and current weight', () => {
    const row = computeSizing({
      signal: { symbol: 'NVDA', band: 'BUY', conviction: 0.5 },
      qualityMult: 1, position: { shares: 10, avgCost: 80 },
      livePrice: 100, portfolioValue: 2000, config,
    });
    expect(row.marketValue).toBe(1000);
    expect(row.currentWeight).toBeCloseTo(0.5, 5);
    expect(row.unrealizedPnl).toBe(200);
    expect(row.unrealizedPnlPct).toBeCloseTo(0.25, 5);
  });

  it('within the rebalance band → hold', () => {
    const row = computeSizing({
      signal: { symbol: 'NVDA', band: 'BUY', conviction: 1 },
      qualityMult: 1, position: { shares: 5, avgCost: 100 }, // 500 of 10000 = 5% current; target 5%
      livePrice: 100, portfolioValue: 10000, config,
    });
    expect(row.action).toBe('hold');
  });

  it('empty/zero-value book → hold, not trim', () => {
    const row = computeSizing({
      signal: { symbol: 'NVDA', band: 'BUY', conviction: 1 },
      qualityMult: 1, position: { shares: 0, avgCost: 0 },
      livePrice: 100, portfolioValue: 0, config,
    });
    expect(row.action).toBe('hold');
  });

  it('flags a stale price', () => {
    const row = computeSizing({
      signal: { symbol: 'NVDA', band: 'BUY', conviction: 1 }, qualityMult: 1,
      position: { shares: 1, avgCost: 1 }, livePrice: null, portfolioValue: 100,
      config, priceStale: true,
    });
    expect(row.flags).toContain('sizing:stale-price');
  });
});

describe('buildSizingBook', () => {
  it('sizes every holding against the live total value', () => {
    const { rows, summary } = buildSizingBook({
      holdings: [{ ticker: 'NVDA', shares: 10, avgCost: 80 }, { ticker: 'AMD', shares: 5, avgCost: 100 }],
      signalsBySymbol: { NVDA: { symbol: 'NVDA', band: 'BUY', conviction: 1 }, AMD: { symbol: 'AMD', band: 'SELL', conviction: 1 } },
      qualityBySymbol: { NVDA: { qualityMult: 1, flags: [] }, AMD: { qualityMult: 1, flags: [] } },
      pricesBySymbol: { NVDA: { price: 100 }, AMD: { price: 120 } },
      config,
    });
    expect(summary.totalValue).toBe(10 * 100 + 5 * 120); // 1600
    expect(rows.find((r) => r.ticker === 'AMD').action).toBe('trim');
    expect(rows).toHaveLength(2);
  });
});

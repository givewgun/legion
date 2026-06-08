import { describe, it, expect } from 'vitest';
import { runReliabilityOnce } from '../../src/run/reliability.js';
import { runBacktestOnce } from '../../src/run/backtest.js';

describe('runReliabilityOnce', () => {
  it('resolves due signals then recomputes reliability, returning a summary', async () => {
    const order = [];
    const repo = {
      listUnresolvedSignals: async () => {
        order.push('list');
        return [];
      },
      resolveSignal: async () => {},
      getSignalStance: async () => 0,
      getResolvedForecasts: async () => {
        order.push('forecasts');
        return [];
      },
      upsertReliability: async () => {},
      getVoteHistory: async () => {
        order.push('votes');
        return [];
      },
      replaceCorrelations: async () => {},
    };
    const gunvest = { getCandles: async () => [] };
    const out = await runReliabilityOnce({ repo, gunvest, clock: () => new Date('2026-06-10') });
    expect(order).toEqual(['list', 'forecasts', 'votes']);
    expect(out).toMatchObject({ resolved: 0, correlations: 0 });
    expect(out.reliability).toEqual({});
  });
});

describe('runBacktestOnce', () => {
  it('runs the deterministic backtest per enabled ticker and records results', async () => {
    const recorded = [];
    const repo = {
      listEnabledTickers: async () => ['NVDA'],
      recordBacktestResult: async (r) => recorded.push(r),
    };
    const candle = (n) => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, close: 100 + i }));
    const gunvest = { getCandles: async () => candle(60) };
    const out = await runBacktestOnce({ repo, gunvest, horizonDays: 3 });
    expect(out.tickers).toBe(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].symbol).toBe('NVDA');
    expect(recorded[0].horizon).toBe(3);
  });
});

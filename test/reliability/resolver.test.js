import { describe, it, expect } from 'vitest';
import { returnOver, resolveSignals } from '../../src/reliability/resolver.js';

const candles = [
  { date: '2026-06-01', close: 100 },
  { date: '2026-06-02', close: 101 },
  { date: '2026-06-06', close: 110 },
];

describe('returnOver', () => {
  it('computes return between first>=from and last<=to', () => {
    expect(returnOver(candles, '2026-06-01', '2026-06-06')).toBeCloseTo(0.1);
  });
  it('returns null when window has <2 usable closes', () => {
    expect(returnOver(candles, '2026-06-10', '2026-06-20')).toBeNull();
  });
});

describe('resolveSignals', () => {
  function gunvestStub(map) {
    return { getCandles: async (sym) => map[sym] };
  }

  it('resolves a bullish signal that beat SPY as correct', async () => {
    const resolved = [];
    const repo = {
      listUnresolvedSignals: async () => [
        { id: 1, symbol: 'NVDA', created_at: '2026-06-01', entry_price: 100 },
      ],
      resolveSignal: async (id, data) => resolved.push({ id, ...data }),
      getSignalStance: async () => 1,
    };
    const gunvest = gunvestStub({
      NVDA: [
        { date: '2026-06-01', close: 100 },
        { date: '2026-06-08', close: 110 },
      ],
      SPY: [
        { date: '2026-06-01', close: 400 },
        { date: '2026-06-08', close: 408 },
      ],
      QQQ: [
        { date: '2026-06-01', close: 300 },
        { date: '2026-06-08', close: 309 },
      ],
    });
    const count = await resolveSignals(repo, gunvest, '2026-06-08');
    expect(count).toBe(1);
    expect(resolved[0].outcome).toBe(1);
    expect(resolved[0].correct).toBe(true);
    expect(resolved[0].forwardReturn).toBeCloseTo(0.1);
  });

  it('marks bullish signal that lagged SPY as incorrect, outcome 0', async () => {
    const resolved = [];
    const repo = {
      listUnresolvedSignals: async () => [
        { id: 2, symbol: 'MU', created_at: '2026-06-01', entry_price: 50 },
      ],
      resolveSignal: async (id, data) => resolved.push({ id, ...data }),
      getSignalStance: async () => 1,
    };
    const gunvest = gunvestStub({
      MU: [
        { date: '2026-06-01', close: 50 },
        { date: '2026-06-08', close: 50.5 },
      ],
      SPY: [
        { date: '2026-06-01', close: 400 },
        { date: '2026-06-08', close: 420 },
      ],
      QQQ: [
        { date: '2026-06-01', close: 300 },
        { date: '2026-06-08', close: 315 },
      ],
    });
    await resolveSignals(repo, gunvest, '2026-06-08');
    expect(resolved[0].outcome).toBe(0);
    expect(resolved[0].correct).toBe(false);
  });

  it('leaves correct null for HOLD signals but still records returns', async () => {
    const resolved = [];
    const repo = {
      listUnresolvedSignals: async () => [
        { id: 3, symbol: 'AMD', created_at: '2026-06-01', entry_price: 80 },
      ],
      resolveSignal: async (id, data) => resolved.push({ id, ...data }),
      getSignalStance: async () => 0,
    };
    const gunvest = gunvestStub({
      AMD: [
        { date: '2026-06-01', close: 80 },
        { date: '2026-06-08', close: 82 },
      ],
      SPY: [
        { date: '2026-06-01', close: 400 },
        { date: '2026-06-08', close: 404 },
      ],
      QQQ: [
        { date: '2026-06-01', close: 300 },
        { date: '2026-06-08', close: 303 },
      ],
    });
    await resolveSignals(repo, gunvest, '2026-06-08');
    expect(resolved[0].correct).toBeNull();
    expect(resolved[0].forwardReturn).toBeCloseTo(0.025);
  });

  it('skips a signal when candle data is insufficient', async () => {
    const resolved = [];
    const repo = {
      listUnresolvedSignals: async () => [
        { id: 4, symbol: 'X', created_at: '2026-06-01', entry_price: 10 },
      ],
      resolveSignal: async (id, data) => resolved.push({ id, ...data }),
      getSignalStance: async () => 1,
    };
    const gunvest = gunvestStub({
      X: [{ date: '2026-06-01', close: 10 }],
      SPY: [],
      QQQ: [],
    });
    const count = await resolveSignals(repo, gunvest, '2026-06-08');
    expect(count).toBe(0);
    expect(resolved).toHaveLength(0);
  });
});

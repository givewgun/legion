import { describe, it, expect, vi } from 'vitest';
import { gatherRisk, dailySigmaPct } from '../../src/risk/gather.js';

const candlesWithVol = (closes) => closes.map((close, i) => ({ date: `d${i}`, close }));

describe('dailySigmaPct', () => {
  it('computes the std-dev (%) of daily log returns', () => {
    // alternating +10% / -9.09%: |log return| constant ~0.0953 -> sigma ~9.53%
    const sigma = dailySigmaPct(candlesWithVol([100, 110, 100, 110, 100, 110]));
    expect(sigma).toBeGreaterThan(9);
    expect(sigma).toBeLessThan(10);
  });

  it('is null on thin history', () => {
    expect(dailySigmaPct(candlesWithVol([100, 101]))).toBeNull();
    expect(dailySigmaPct(null)).toBeNull();
    expect(dailySigmaPct([])).toBeNull();
  });

  it('is near zero for a flat series', () => {
    expect(dailySigmaPct(candlesWithVol([100, 100, 100, 100, 100, 100]))).toBeCloseTo(0);
  });
});

describe('gatherRisk', () => {
  const gunvest = (overrides = {}) => ({
    getPrice: async () => ({ changePercent: 2.5 }),
    getMacro: async () => ({ vix: 18 }),
    getCandles: async () => candlesWithVol([100, 110, 100, 110, 100, 110]),
    ...overrides,
  });

  it('returns move, vix, and the realized daily sigma', async () => {
    const data = await gatherRisk(gunvest(), 'nvda');
    expect(data.changePercent).toBe(2.5);
    expect(data.vix).toBe(18);
    expect(data.dailySigmaPct).toBeGreaterThan(9);
  });

  it('degrades to null sigma when the candle fetch fails', async () => {
    const data = await gatherRisk(
      gunvest({
        getCandles: vi.fn(async () => {
          throw new Error('feed down');
        }),
      }),
      'NVDA',
    );
    expect(data.dailySigmaPct).toBeNull();
    expect(data.vix).toBe(18); // the rest of the constraint inputs survive
  });
});

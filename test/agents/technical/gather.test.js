import { describe, it, expect } from 'vitest';
import { gather } from '../../../src/agents/technical/gather.js';

const history = Array.from({ length: 60 }, (_, i) => ({
  date: `2026-01-${i + 1}`,
  close: 100 + i,
}));

describe('gather', () => {
  it('returns a lean quote plus indicators derived from history', async () => {
    const fakeClient = {
      getPrice: async (s) => ({ symbol: s, price: 159, changePct: 1.5, history }),
    };
    const data = await gather(fakeClient, 'NVDA');
    expect(data.quote).toMatchObject({ price: 159, changePct: 1.5 });
    expect(data.indicators.sma20).toBeCloseTo(149.5, 5); // mean of last 20 closes 140..159
    expect(data.indicators.latestClose).toBe(159);
  });

  it('still returns the quote when history is empty (fallback path)', async () => {
    const fakeClient = {
      getPrice: async () => ({ price: 42, changePct: 0, history: [] }),
    };
    const data = await gather(fakeClient, 'MU');
    expect(data.quote.price).toBe(42);
    expect(data.indicators).toEqual({});
  });

  it('uppercases the symbol when calling the client', async () => {
    let seen;
    const fakeClient = {
      getPrice: async (s) => {
        seen = s;
        return { price: 1 };
      },
    };
    await gather(fakeClient, 'mu');
    expect(seen).toBe('MU');
  });
});

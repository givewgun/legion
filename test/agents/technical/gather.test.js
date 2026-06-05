import { describe, it, expect } from 'vitest';
import { gather } from '../../../src/agents/technical/gather.js';

describe('gather', () => {
  it('pulls price data from the GunVest client', async () => {
    const fakeClient = {
      getPrice: async (s) => ({ symbol: s, price: 120, changePercent: 1.5 }),
    };
    const data = await gather(fakeClient, 'NVDA');
    expect(data).toEqual({ symbol: 'NVDA', price: 120, changePercent: 1.5 });
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

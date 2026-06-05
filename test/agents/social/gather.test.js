import { describe, it, expect } from 'vitest';
import { gather } from '../../../src/agents/social/gather.js';

describe('social gather', () => {
  it('pulls sentiment for the uppercased symbol', async () => {
    let seen;
    const gunvest = {
      getSentiment: async (s) => {
        seen = s;
        return { score: 0.6, volume: 1200 };
      },
    };
    const data = await gather(gunvest, 'mu');
    expect(seen).toBe('MU');
    expect(data).toEqual({ sentiment: { score: 0.6, volume: 1200 } });
  });
});

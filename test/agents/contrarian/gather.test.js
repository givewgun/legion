import { describe, it, expect } from 'vitest';
import { gather } from '../../../src/agents/contrarian/gather.js';

describe('contrarian gather', () => {
  it('merges per-ticker sentiment with the positioning panel, uppercasing the symbol', async () => {
    const seen = {};
    const gunvest = {
      getSentiment: async (s) => {
        seen.sentiment = s;
        return { score: 0.9, volume: 5000 };
      },
    };
    const feeds = {
      gather: async (s) => {
        seen.feeds = s;
        return {
          fearGreed: { value: 78 },
          vix: 13,
          putCall: { ratio: 0.6 },
          aaii: null,
          naaim: null,
          shortInterest: { shortInterest: 1200 },
        };
      },
    };

    const data = await gather(gunvest, 'nvda', feeds);
    expect(seen.sentiment).toBe('NVDA');
    expect(seen.feeds).toBe('NVDA');
    expect(data).toEqual({
      sentiment: { score: 0.9, volume: 5000 },
      fearGreed: { value: 78 },
      vix: 13,
      putCall: { ratio: 0.6 },
      aaii: null,
      naaim: null,
      shortInterest: { shortInterest: 1200 },
    });
  });
});

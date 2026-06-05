import { describe, it, expect } from 'vitest';
import { gather } from '../../../src/agents/news/gather.js';

describe('news gather', () => {
  it('pulls headlines and the macro snapshot, uppercasing the symbol', async () => {
    const seen = {};
    const gunvest = {
      getNews: async (s) => {
        seen.news = s;
        return [{ title: 'Q earnings beat' }];
      },
      getMacro: async () => ({ vix: 14 }),
    };
    const data = await gather(gunvest, 'nvda');
    expect(seen.news).toBe('NVDA');
    expect(data).toEqual({ news: [{ title: 'Q earnings beat' }], macro: { vix: 14 } });
  });
});

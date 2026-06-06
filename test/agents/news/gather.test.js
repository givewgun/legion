import { describe, it, expect } from 'vitest';
import { gather } from '../../../src/agents/news/gather.js';

describe('news gather', () => {
  it('shapes the headlines and passes the macro snapshot, uppercasing the symbol', async () => {
    const seen = {};
    const gunvest = {
      getNews: async (s) => {
        seen.news = s;
        return [
          {
            id: 9,
            headline: 'NVDA earnings beat',
            summary: 'guidance raised',
            source: 'Yahoo',
            url: 'https://x',
            imageUrl: 'https://img',
            datetime: '2026-06-06T00:00:00.000Z',
            sentiment: 'positive',
            ticker: 'NVDA',
          },
        ];
      },
      getMacro: async () => ({ vix: 14 }),
    };
    const data = await gather(gunvest, 'nvda');
    expect(seen.news).toBe('NVDA');
    expect(data.macro).toEqual({ vix: 14 });
    expect(data.headlines).toHaveLength(1);
    expect(data.headlines[0]).toMatchObject({ headline: 'NVDA earnings beat', sentiment: 'positive' });
    expect(data.headlines[0]).not.toHaveProperty('url');
    expect(data.headlines[0]).not.toHaveProperty('id');
  });

  it('yields empty headlines when the feed is empty', async () => {
    const gunvest = { getNews: async () => [], getMacro: async () => ({}) };
    const data = await gather(gunvest, 'MU');
    expect(data.headlines).toEqual([]);
  });
});

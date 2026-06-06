import { describe, it, expect } from 'vitest';
import { shapeHeadlines } from '../../../src/agents/news/shape.js';

// Mirrors the real GET /api/news/:ticker shape: every item is stamped with the
// requested ticker, most are off-topic, relatedTickers is usually empty, and
// each carries junk fields (id, url, imageUrl) the LLM does not need.
const feed = [
  {
    id: 1,
    headline: 'Broad market dips on rate fears',
    summary: 'Stocks fell across the board.',
    source: 'Yahoo',
    url: 'https://finnhub.io/x',
    imageUrl: 'https://img/x.png',
    datetime: '2026-06-06T01:00:00.000Z',
    sentiment: 'negative',
    category: 'company',
    relatedTickers: [],
    ticker: 'NVDA',
  },
  {
    id: 2,
    headline: 'NVDA jumps on AI demand',
    summary: 'The chip leader rallied.',
    source: 'Yahoo',
    url: 'https://finnhub.io/y',
    imageUrl: 'https://img/y.png',
    datetime: '2026-06-05T10:00:00.000Z',
    sentiment: 'positive',
    category: 'company',
    relatedTickers: ['NVDA'],
    ticker: 'NVDA',
  },
  {
    id: 3,
    headline: 'Quiet session for industrials',
    summary: 'Little movement.',
    source: 'Yahoo',
    url: 'https://finnhub.io/z',
    imageUrl: 'https://img/z.png',
    datetime: '2026-06-01T00:00:00.000Z',
    sentiment: 'neutral',
    category: 'company',
    relatedTickers: [],
    ticker: 'NVDA',
  },
];

describe('shapeHeadlines', () => {
  it('strips junk fields, keeping only the lean set', () => {
    const [first] = shapeHeadlines(feed, 'NVDA');
    expect(Object.keys(first).sort()).toEqual(
      ['category', 'datetime', 'headline', 'sentiment', 'source', 'summary'].sort(),
    );
    expect(first).not.toHaveProperty('id');
    expect(first).not.toHaveProperty('url');
    expect(first).not.toHaveProperty('imageUrl');
    expect(first).not.toHaveProperty('relatedTickers');
    expect(first).not.toHaveProperty('ticker');
  });

  it('orders on-topic items first even when an off-topic item is more recent', () => {
    const out = shapeHeadlines(feed, 'NVDA');
    expect(out[0].headline).toBe('NVDA jumps on AI demand');
  });

  it('treats relatedTickers membership as on-topic when the text omits the symbol', () => {
    const item = {
      headline: 'Chip sector roundup',
      summary: 'No tickers named in the body.',
      datetime: '2026-06-02T00:00:00.000Z',
      relatedTickers: ['NVDA'],
    };
    const out = shapeHeadlines([feed[0], item], 'NVDA');
    expect(out[0].headline).toBe('Chip sector roundup');
  });

  it('backfills with recent items so a name≠symbol ticker still gets a full set', () => {
    // None of these literally contain "TSM"; all should still come through, recency-ordered.
    const out = shapeHeadlines(feed, 'TSM');
    expect(out).toHaveLength(3);
    expect(out[0].datetime).toBe('2026-06-06T01:00:00.000Z');
  });

  it('caps the result at the limit', () => {
    expect(shapeHeadlines(feed, 'NVDA', { limit: 2 })).toHaveLength(2);
  });

  it('returns [] for empty or non-array input', () => {
    expect(shapeHeadlines([], 'NVDA')).toEqual([]);
    expect(shapeHeadlines(null, 'NVDA')).toEqual([]);
    expect(shapeHeadlines(undefined, 'NVDA')).toEqual([]);
  });
});

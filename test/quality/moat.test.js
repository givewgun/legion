import { describe, it, expect } from 'vitest';
import { createMoatScorer } from '../../src/quality/moat.js';

const fakeGunvest = { getFundamentals: async () => ({ sector: 'Technology' }), getNews: async () => ({ items: [] }) };
// Silent logger keeps the expected-failure tests from polluting test output.
const quietLogger = { warn() {} };

describe('moat scorer', () => {
  it('parses a [0,1] score from the LLM reply', async () => {
    const provider = { generate: async () => 'MOAT: 0.8 — strong network effects' };
    const score = await createMoatScorer({ provider, gunvest: fakeGunvest })('META');
    expect(score).toBeCloseTo(0.8, 5);
  });

  it('returns null when the LLM fails', async () => {
    const provider = { generate: async () => { throw new Error('llm down'); } };
    const score = await createMoatScorer({ provider, gunvest: fakeGunvest, logger: quietLogger })('META');
    expect(score).toBeNull();
  });

  it('returns null on an unparseable reply', async () => {
    const provider = { generate: async () => 'no number here' };
    expect(await createMoatScorer({ provider, gunvest: fakeGunvest })('META')).toBeNull();
  });
});

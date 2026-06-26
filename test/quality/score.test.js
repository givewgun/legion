import { describe, it, expect } from 'vitest';
import { computeQuality, scoreFundamentals, scoreValuation, scoreAnalyst } from '../../src/quality/score.js';

describe('quality sub-scores', () => {
  it('scoreValuation rewards cheaper P/E and PEG', () => {
    const cheap = scoreValuation({ trailingPE: 8, pegRatio: 0.7 });
    const rich = scoreValuation({ trailingPE: 55, pegRatio: 2.8 });
    expect(cheap).toBeGreaterThan(rich);
    expect(cheap).toBeLessThanOrEqual(1);
    expect(rich).toBeGreaterThanOrEqual(0);
  });

  it('scoreFundamentals rewards margins/ROE/growth, penalizes debt', () => {
    const strong = scoreFundamentals({ profitMargins: 0.3, returnOnEquity: 0.3, revenueGrowth: 0.3, debtToEquity: 0, freeCashflow: 1e9 });
    const weak = scoreFundamentals({ profitMargins: 0, returnOnEquity: 0, revenueGrowth: 0, debtToEquity: 200, freeCashflow: -1e8 });
    expect(strong).toBeGreaterThan(weak);
  });

  it('scoreAnalyst combines rating and target upside', () => {
    const bull = scoreAnalyst({ recommendationKey: 'strong_buy', targetMeanPrice: 150, numberOfAnalystOpinions: 30 }, 100);
    const bear = scoreAnalyst({ recommendationKey: 'sell', targetMeanPrice: 90, numberOfAnalystOpinions: 30 }, 100);
    expect(bull).toBeGreaterThan(bear);
  });

  it('scoreAnalyst returns null when no analyst coverage', () => {
    expect(scoreAnalyst({}, 100)).toBeNull();
  });
});

describe('computeQuality', () => {
  it('maps an average company to ~1.0 and clamps to [0.5,1.5]', () => {
    const q = computeQuality({
      fundamentals: { profitMargins: 0.15, returnOnEquity: 0.15, revenueGrowth: 0.15, debtToEquity: 100, freeCashflow: 1, trailingPE: 30, pegRatio: 1.75 },
      analyst: { recommendationKey: 'hold', targetMeanPrice: 100, numberOfAnalystOpinions: 10 },
      moat: 0.5, livePrice: 100,
    });
    expect(q.qualityMult).toBeGreaterThanOrEqual(0.5);
    expect(q.qualityMult).toBeLessThanOrEqual(1.5);
    expect(q.qualityMult).toBeCloseTo(1.0, 1);
    expect(q.flags).toEqual([]);
  });

  it('degrades missing factors to neutral and flags them', () => {
    const q = computeQuality({ fundamentals: null, analyst: null, moat: null, livePrice: 100 });
    expect(q.qualityMult).toBeCloseTo(1.0, 5); // all neutral 0.5 → blend 0.5 → mult 1.0
    expect(q.flags).toContain('quality:fundamentals-missing');
    expect(q.flags).toContain('quality:analyst-missing');
    expect(q.flags).toContain('quality:moat-missing');
    expect(q.flags).toContain('quality:valuation-missing');
  });
});

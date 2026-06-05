import { describe, it, expect } from 'vitest';
import { applyRiskConstraint } from '../../src/risk/apply.js';

const baseSignal = {
  symbol: 'NVDA',
  band: 'STRONG_BUY',
  conviction: 0.9,
  plan: { horizon: 'swing', rationales: [] },
};

describe('applyRiskConstraint', () => {
  it('returns the signal unchanged when there is no constraint', () => {
    expect(applyRiskConstraint(baseSignal, null)).toBe(baseSignal);
  });

  it('records the reason without changing a within-cap signal', () => {
    const out = applyRiskConstraint(
      { ...baseSignal, conviction: 0.3 },
      { capConviction: 0.5, blockBuy: false, reason: 'elevated VIX 31' },
    );
    expect(out.conviction).toBe(0.3);
    expect(out.band).toBe('STRONG_BUY');
    expect(out.plan.riskReason).toBe('elevated VIX 31');
    expect(out.plan.riskCapped).toBeUndefined();
  });

  it('caps conviction above the cap', () => {
    const out = applyRiskConstraint(baseSignal, {
      capConviction: 0.5,
      blockBuy: false,
      reason: 'elevated VIX 31',
    });
    expect(out.conviction).toBe(0.5);
    expect(out.plan.riskCapped).toBe(true);
    expect(out.band).toBe('STRONG_BUY'); // direction preserved
  });

  it('downgrades a buy to HOLD when new longs are blocked', () => {
    const out = applyRiskConstraint(baseSignal, {
      capConviction: 1,
      blockBuy: true,
      reason: 'extreme VIX 42',
    });
    expect(out.band).toBe('HOLD');
    expect(out.conviction).toBe(0);
    expect(out.plan.riskBlocked).toBe(true);
  });

  it('does not block a sell signal', () => {
    const sell = { ...baseSignal, band: 'STRONG_SELL', conviction: 0.8 };
    const out = applyRiskConstraint(sell, {
      capConviction: 1,
      blockBuy: true,
      reason: 'extreme VIX 42',
    });
    expect(out.band).toBe('STRONG_SELL');
    expect(out.plan.riskBlocked).toBeUndefined();
  });
});

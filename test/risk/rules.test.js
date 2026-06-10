import { describe, it, expect } from 'vitest';
import { computeConstraint } from '../../src/risk/rules.js';

describe('computeConstraint', () => {
  it('imposes no cap in calm conditions', () => {
    const c = computeConstraint({ vix: 14, changePercent: 1.2 });
    expect(c).toEqual({ capConviction: 1, blockBuy: false, reason: 'no risk flags' });
  });

  it('caps conviction when VIX is elevated', () => {
    const c = computeConstraint({ vix: 32, changePercent: 1 });
    expect(c.capConviction).toBe(0.5);
    expect(c.blockBuy).toBe(false);
    expect(c.reason).toMatch(/VIX/);
  });

  it('blocks new longs when VIX is extreme', () => {
    const c = computeConstraint({ vix: 42, changePercent: 1 });
    expect(c.blockBuy).toBe(true);
  });

  it('caps harder on an outsized daily move (chasing risk)', () => {
    const c = computeConstraint({ vix: 15, changePercent: -9.5 });
    expect(c.capConviction).toBe(0.4);
    expect(c.reason).toMatch(/move/);
  });

  describe('vol-normalized move trip (ADR 0022)', () => {
    it('trips on a 3-sigma move in a quiet name well below the flat 8%', () => {
      // a utility with 1% daily vol: a 4% day is a 4-sigma event
      const c = computeConstraint({ vix: 15, changePercent: 4, dailySigmaPct: 1 });
      expect(c.capConviction).toBe(0.4);
      expect(c.reason).toMatch(/of this name/);
    });

    it('does not trip the flat 8% on a name that routinely moves that much', () => {
      // a meme stock with 4% daily vol: 8% is only 2 sigma — not outsized for it
      const c = computeConstraint({ vix: 15, changePercent: 8, dailySigmaPct: 4 });
      expect(c.capConviction).toBe(1);
    });

    it('falls back to the absolute 8% threshold when vol is unavailable', () => {
      expect(computeConstraint({ vix: 15, changePercent: 7.5 }).capConviction).toBe(1);
      expect(computeConstraint({ vix: 15, changePercent: 8.5 }).capConviction).toBe(0.4);
      expect(
        computeConstraint({ vix: 15, changePercent: 8.5, dailySigmaPct: null }).capConviction,
      ).toBe(0.4);
    });
  });

  it('takes the tightest cap when multiple flags fire', () => {
    const c = computeConstraint({ vix: 33, changePercent: 12 });
    expect(c.capConviction).toBe(0.4); // min(0.5, 0.4)
  });

  it('treats missing fields as calm', () => {
    expect(computeConstraint({})).toEqual({
      capConviction: 1,
      blockBuy: false,
      reason: 'no risk flags',
    });
  });
});

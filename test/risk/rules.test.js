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

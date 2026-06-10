import { describe, it, expect } from 'vitest';
import { buildSignal } from '../../src/emit/plan.js';

const votes = [
  { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
];

describe('buildSignal', () => {
  it('emits a converged signal with band and conviction', () => {
    const evalResult = { S: 1.8, V: 0.0, kappa: 1, converged: true, band: 'STRONG_BUY' };
    const sig = buildSignal(evalResult, { symbol: 'NVDA', votes });
    expect(sig.symbol).toBe('NVDA');
    expect(sig.band).toBe('STRONG_BUY');
    expect(sig.conviction).toBeCloseTo(0.9, 6); // |S|/2 capped at 1
    expect(sig.plan.rationales).toEqual([{ agentId: 'technical', rationale: 'breakout' }]);
  });

  it('emits NO_CONSENSUS when the round did not converge', () => {
    const evalResult = { S: 0.1, V: 4, kappa: 0.5, converged: false, band: 'HOLD' };
    const sig = buildSignal(evalResult, { symbol: 'MU', votes });
    expect(sig.band).toBe('NO_CONSENSUS');
    expect(sig.conviction).toBe(0);
  });

  it('tags the plan when the effective panel was degraded', () => {
    const evalResult = {
      S: 1.0,
      V: 0.1,
      kappa: 1,
      converged: true,
      band: 'BUY',
      nEff: 2,
      degraded: true,
    };
    const sig = buildSignal(evalResult, { symbol: 'NVDA', votes });
    expect(sig.plan.degradedQuorum).toBe(true);
    expect(sig.plan.nEff).toBe(2);
  });

  it('omits the degraded tag on a full panel', () => {
    const evalResult = {
      S: 1.0,
      V: 0.1,
      kappa: 1,
      converged: true,
      band: 'BUY',
      nEff: 4,
      degraded: false,
    };
    const sig = buildSignal(evalResult, { symbol: 'NVDA', votes });
    expect(sig.plan.degradedQuorum).toBeUndefined();
  });
});

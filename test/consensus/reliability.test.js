import { describe, it, expect } from 'vitest';
import {
  forecastProb,
  brier,
  reliabilityFromBrier,
  scaleWeights,
  MIN_RESOLVED,
} from '../../src/consensus/reliability.js';

describe('forecastProb', () => {
  it('maps strong buy + full conviction to 1.0', () => {
    expect(forecastProb(2, 1)).toBeCloseTo(1.0);
  });
  it('maps strong sell + full conviction to 0.0', () => {
    expect(forecastProb(-2, 1)).toBeCloseTo(0.0);
  });
  it('maps HOLD to 0.5 regardless of conviction', () => {
    expect(forecastProb(0, 0.9)).toBeCloseTo(0.5);
  });
  it('clamps to [0,1]', () => {
    expect(forecastProb(2, 5)).toBe(1);
    expect(forecastProb(-2, 5)).toBe(0);
  });
});

describe('brier', () => {
  it('is squared error of forecast vs outcome', () => {
    expect(brier(0.8, 1)).toBeCloseTo(0.04);
    expect(brier(0.8, 0)).toBeCloseTo(0.64);
  });
});

describe('reliabilityFromBrier', () => {
  it('returns neutral 1.0 below min sample', () => {
    expect(reliabilityFromBrier(0.0, MIN_RESOLVED - 1)).toBe(1.0);
  });
  it('perfect mean Brier -> 1.5 cap', () => {
    expect(reliabilityFromBrier(0.0, 50)).toBeCloseTo(1.5);
  });
  it('random mean Brier 0.25 -> neutral 1.0', () => {
    expect(reliabilityFromBrier(0.25, 50)).toBeCloseTo(1.0);
  });
  it('anti-skill mean Brier 0.5 -> 0.5 floor', () => {
    expect(reliabilityFromBrier(0.5, 50)).toBeCloseTo(0.5);
  });
  it('clamps below floor', () => {
    expect(reliabilityFromBrier(0.9, 50)).toBe(0.5);
  });
});

describe('scaleWeights', () => {
  it('multiplies each vote weight by its agent rho, default 1.0', () => {
    const votes = [
      { agentId: 'technical', weight: 1.0, stance: 1, conviction: 0.8 },
      { agentId: 'news', weight: 1.2, stance: -1, conviction: 0.5 },
    ];
    const out = scaleWeights(votes, { technical: 1.5 });
    expect(out[0].weight).toBeCloseTo(1.5);
    expect(out[1].weight).toBeCloseTo(1.2);
  });
  it('does not mutate input', () => {
    const votes = [{ agentId: 'a', weight: 1, stance: 0, conviction: 0 }];
    scaleWeights(votes, { a: 0.5 });
    expect(votes[0].weight).toBe(1);
  });
});

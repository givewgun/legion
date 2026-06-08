import { describe, it, expect } from 'vitest';
import {
  forecastProb,
  brier,
  reliabilityFromBrier,
  scaleWeights,
  scaleConviction,
  calibrationFromSamples,
  directionalHit,
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

describe('directionalHit', () => {
  it('bullish call hits when it beat SPY (outcome 1)', () => {
    expect(directionalHit(2, 1)).toBe(1);
    expect(directionalHit(1, 0)).toBe(0);
  });
  it('bearish call hits when it lagged SPY (outcome 0)', () => {
    expect(directionalHit(-2, 0)).toBe(1);
    expect(directionalHit(-1, 1)).toBe(0);
  });
  it('HOLD makes no directional claim', () => {
    expect(directionalHit(0, 1)).toBeNull();
  });
});

describe('calibrationFromSamples', () => {
  const mk = (conviction, hit, n) => Array.from({ length: n }, () => ({ conviction, hit }));

  it('stays neutral below MIN_RESOLVED', () => {
    const samples = [...mk(0.9, 1, 2), ...mk(0.2, 0, 2)];
    expect(samples.length).toBeLessThan(MIN_RESOLVED);
    expect(calibrationFromSamples(samples)).toBe(1.0);
  });
  it('stays neutral without both a hit and a miss', () => {
    expect(calibrationFromSamples(mk(0.9, 1, 6))).toBe(1.0);
    expect(calibrationFromSamples(mk(0.9, 0, 6))).toBe(1.0);
  });
  it('boosts when confident on hits, hedged on misses', () => {
    const samples = [...mk(0.8, 1, 3), ...mk(0.5, 0, 3)];
    expect(calibrationFromSamples(samples)).toBeCloseTo(1.3); // 1 + (0.8 - 0.5)
  });
  it('clamps a strong discriminator to the 1.5 cap', () => {
    const samples = [...mk(1, 1, 3), ...mk(0, 0, 3)];
    expect(calibrationFromSamples(samples)).toBe(1.5);
  });
  it('cuts to the 0.5 floor when confidently wrong', () => {
    const samples = [...mk(0, 1, 3), ...mk(1, 0, 3)];
    expect(calibrationFromSamples(samples)).toBe(0.5);
  });
});

describe('scaleConviction', () => {
  it('multiplies each conviction by its agent calibration, default 1.0', () => {
    const votes = [
      { agentId: 'technical', weight: 1, stance: 1, conviction: 0.8 },
      { agentId: 'news', weight: 1, stance: 1, conviction: 0.5 },
    ];
    const out = scaleConviction(votes, { technical: 0.5 });
    expect(out[0].conviction).toBeCloseTo(0.4);
    expect(out[1].conviction).toBeCloseTo(0.5);
  });
  it('clamps scaled conviction back into [0,1]', () => {
    const votes = [{ agentId: 'a', weight: 1, stance: 1, conviction: 0.8 }];
    expect(scaleConviction(votes, { a: 1.5 })[0].conviction).toBe(1);
  });
  it('does not mutate input', () => {
    const votes = [{ agentId: 'a', weight: 1, stance: 1, conviction: 0.8 }];
    scaleConviction(votes, { a: 0.5 });
    expect(votes[0].conviction).toBe(0.8);
  });
});

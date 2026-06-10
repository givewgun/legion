import { describe, it, expect } from 'vitest';
import {
  forecastProb,
  brier,
  gradedOutcome,
  reliabilityFromBrier,
  scaleWeights,
  scaleConviction,
  calibrationFromSamples,
  boundCombined,
  directionalHit,
  decayWeights,
  weightedMean,
  effectiveSampleSize,
  stanceVariance,
  informationFactor,
  ALPHA_SCALE,
  MIN_RESOLVED,
  SHRINK_K,
} from '../../src/consensus/reliability.js';

// Shrinkage factor for a uniform-weight sample of size n (ADR 0019).
const shrink = (n) => n / (n + SHRINK_K);

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
  it('perfect mean Brier approaches the 1.5 cap as evidence deepens', () => {
    // shrinkage (ADR 0019): the cap is an asymptote, not a hot-streak destination
    expect(reliabilityFromBrier(0.0, 50)).toBeCloseTo(1 + 2 * 0.25 * shrink(50));
    expect(reliabilityFromBrier(0.0, 50)).toBeLessThan(1.5);
    expect(reliabilityFromBrier(0.0, 1000)).toBeGreaterThan(
      reliabilityFromBrier(0.0, 50, 0.25, 50),
    );
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
  it('penalizes worse-than-chance steeper than it rewards better-than-chance', () => {
    // Same 0.05 distance either side of 0.25: up-slope 2, down-slope 4 (then shrunk).
    const better = reliabilityFromBrier(0.2, 50); // 1 + 2*0.05*shrink(50)
    const worse = reliabilityFromBrier(0.3, 50); // 1 - 4*0.05*shrink(50)
    expect(better).toBeCloseTo(1 + 2 * 0.05 * shrink(50));
    expect(worse).toBeCloseTo(1 - 4 * 0.05 * shrink(50));
    expect(1 - worse).toBeGreaterThan(better - 1); // asymmetric: drops faster than it climbs
  });

  it('shrinks a thin sample toward neutral harder than a deep one (ADR 0019)', () => {
    // identical perfect record, different evidence depth
    const thin = reliabilityFromBrier(0.0, MIN_RESOLVED, 0.25, MIN_RESOLVED);
    const deep = reliabilityFromBrier(0.0, 50, 0.25, 50);
    expect(thin).toBeGreaterThan(1);
    expect(thin).toBeLessThan(deep);
  });

  describe('graded baseline (ADR 0018)', () => {
    it('keeps an uninformative forecaster at exactly 1.0 when outcomes cluster near 0.5', () => {
      // graded outcomes near 0.5 give a tiny baseline; a p=0.5 forecaster scores the
      // SAME tiny Brier -> skill score 0 -> neutral, never inflated.
      expect(reliabilityFromBrier(0.01, 50, 0.01)).toBeCloseTo(1.0);
    });
    it('rewards beating the baseline proportionally to relative skill', () => {
      // meanBrier half the baseline -> BSS 0.5 -> edge 0.125, then shrunk
      expect(reliabilityFromBrier(0.05, 50, 0.1)).toBeCloseTo(1 + 2 * 0.125 * shrink(50));
    });
    it('punishes losing to the baseline on the steeper slope', () => {
      // meanBrier 1.5x baseline -> BSS -0.5 -> edge -0.125, shrunk then 4x slope
      expect(reliabilityFromBrier(0.15, 50, 0.1)).toBeCloseTo(1 - 4 * 0.125 * shrink(50));
    });
    it('is neutral when the baseline is degenerate (zero outcome spread)', () => {
      expect(reliabilityFromBrier(0.0, 50, 0)).toBe(1.0);
    });
    it('reduces exactly to the binary formula when the baseline is 0.25', () => {
      expect(reliabilityFromBrier(0.2, 50, 0.25)).toBeCloseTo(reliabilityFromBrier(0.2, 50));
    });
  });
});

describe('gradedOutcome', () => {
  it('is 0.5 when the call exactly matched SPY', () => {
    expect(gradedOutcome(0.03, 0.03)).toBeCloseTo(0.5);
  });
  it('grows toward 1 with positive alpha and shrinks toward 0 with negative', () => {
    expect(gradedOutcome(0.05, 0)).toBeGreaterThan(0.85);
    expect(gradedOutcome(-0.05, 0)).toBeLessThan(0.15);
  });
  it('treats a basis-point alpha as near coin-flip, unlike the binary outcome', () => {
    const g = gradedOutcome(0.0001, 0);
    expect(g).toBeGreaterThan(0.5);
    expect(g).toBeLessThan(0.51);
  });
  it('saturates instead of growing without bound', () => {
    expect(gradedOutcome(10, 0)).toBeLessThanOrEqual(1);
    expect(gradedOutcome(-10, 0)).toBeGreaterThanOrEqual(0);
  });
  it('returns null when either leg is missing (legacy rows)', () => {
    expect(gradedOutcome(null, 0.01)).toBeNull();
    expect(gradedOutcome(0.01, null)).toBeNull();
  });
  it('honors a custom alpha scale', () => {
    expect(gradedOutcome(ALPHA_SCALE, 0)).toBeCloseTo(gradedOutcome(0.1, 0, 0.1), 10);
  });
});

describe('decayWeights / weightedMean', () => {
  it('weights the most recent slot highest and decays monotonically', () => {
    const w = decayWeights(4);
    expect(w[0]).toBe(1);
    expect(w[0]).toBeGreaterThan(w[1]);
    expect(w[1]).toBeGreaterThan(w[2]);
  });
  it('reduces to a simple mean when weights are uniform', () => {
    expect(weightedMean([1, 2, 3], [1, 1, 1])).toBeCloseTo(2);
  });
  it('pulls the mean toward the higher-weighted (recent) values', () => {
    // value 0 most recent (weight 1), value 1 older (weight 0.5) -> below the flat mean 0.5
    expect(weightedMean([0, 1], [1, 0.5])).toBeCloseTo(1 / 3);
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
    // d = 0.3, shrunk by ess 6 (ADR 0019)
    expect(calibrationFromSamples(samples)).toBeCloseTo(1 + 0.3 * shrink(6));
  });
  it('clamps a strong, well-evidenced discriminator to the 1.5 cap', () => {
    const samples = [...mk(1, 1, 10), ...mk(0, 0, 10)];
    // d = 1, shrink(20) = 2/3 -> 1.667 -> clamped
    expect(calibrationFromSamples(samples)).toBe(1.5);
  });
  it('cuts a well-evidenced anti-discriminator to the 0.5 floor', () => {
    const samples = [...mk(0, 1, 10), ...mk(1, 0, 10)];
    expect(calibrationFromSamples(samples)).toBe(0.5);
  });
  it('keeps a thin-sample discriminator closer to neutral than a deep one', () => {
    const thin = calibrationFromSamples([...mk(1, 1, 3), ...mk(0, 0, 3)]);
    const deep = calibrationFromSamples([...mk(1, 1, 10), ...mk(0, 0, 10)]);
    expect(thin).toBeGreaterThan(1);
    expect(thin).toBeLessThan(deep);
  });
});

describe('effectiveSampleSize', () => {
  it('equals n for uniform weights', () => {
    expect(effectiveSampleSize([1, 1, 1, 1])).toBeCloseTo(4);
  });
  it('shrinks below n when weight concentrates on few rows', () => {
    expect(effectiveSampleSize([1, 0.1, 0.1, 0.1])).toBeLessThan(2);
  });
  it('is 0 for an empty sample', () => {
    expect(effectiveSampleSize([])).toBe(0);
  });
});

describe('stanceVariance / informationFactor', () => {
  it('a constant voter has zero variance', () => {
    expect(stanceVariance([1, 1, 1, 1], [1, 1, 1, 1])).toBe(0);
  });
  it('an occasionally-moving voter has positive variance', () => {
    expect(stanceVariance([1, 0, 1, 2], [1, 1, 1, 1])).toBeGreaterThan(0);
  });
  it('floors a zero-variance voter at the info floor', () => {
    expect(informationFactor(0, 10)).toBe(0.25);
  });
  it('grants the full factor at or above the reference variance', () => {
    expect(informationFactor(0.25, 10)).toBe(1);
    expect(informationFactor(2, 10)).toBe(1);
  });
  it('interpolates linearly below the reference', () => {
    expect(informationFactor(0.125, 10)).toBeCloseTo(0.5);
  });
  it('stays neutral below MIN_RESOLVED (cold start)', () => {
    expect(informationFactor(0, MIN_RESOLVED - 1)).toBe(1.0);
  });
});

describe('boundCombined', () => {
  it('caps the combined multiplier at 2.0 by trimming calibration, not rho', () => {
    const out = boundCombined(1.5, 1.5); // product 2.25
    expect(out.rho).toBe(1.5);
    expect(out.calibration).toBeCloseTo(2.0 / 1.5);
    expect(out.rho * out.calibration).toBeCloseTo(2.0);
  });
  it('floors the combined multiplier at 0.4', () => {
    const out = boundCombined(0.5, 0.5); // product 0.25
    expect(out.rho).toBe(0.5);
    expect(out.calibration).toBeCloseTo(0.8);
    expect(out.rho * out.calibration).toBeCloseTo(0.4);
  });
  it('leaves an in-band pair untouched', () => {
    expect(boundCombined(1.2, 1.1)).toEqual({ rho: 1.2, calibration: 1.1 });
  });
  it('adjusted calibration stays inside its own [0.5, 1.5] band', () => {
    for (const [rho, cal] of [
      [1.5, 1.5],
      [0.5, 0.5],
      [0.6, 0.5],
      [1.4, 1.5],
    ]) {
      const out = boundCombined(rho, cal);
      expect(out.calibration).toBeGreaterThanOrEqual(0.5);
      expect(out.calibration).toBeLessThanOrEqual(1.5);
    }
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

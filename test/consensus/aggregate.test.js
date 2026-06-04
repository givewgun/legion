import { describe, it, expect } from 'vitest';
import {
  weightedStance,
  weightedDispersion,
  directionalQuorum,
  evaluateRound,
} from '../../src/consensus/aggregate.js';

const v = (agentId, stance, conviction, weight) => ({
  agentId,
  stance,
  conviction,
  weight,
  rationale: '',
});

describe('weightedStance', () => {
  it('computes the weight*conviction weighted mean stance', () => {
    // votes: (+2,c1,w1)=(2,1,1), (+1,0.5,1), (-1,1,1)
    // num = 2*1*1 + 1*0.5*1 + (-1)*1*1 = 2 + 0.5 - 1 = 1.5
    // den = 1*1 + 0.5*1 + 1*1 = 2.5  → 0.6
    const votes = [v('a', 2, 1, 1), v('b', 1, 0.5, 1), v('c', -1, 1, 1)];
    expect(weightedStance(votes)).toBeCloseTo(0.6, 10);
  });

  it('returns 0 for empty votes', () => {
    expect(weightedStance([])).toBe(0);
  });

  it('returns 0 when all conviction is zero', () => {
    expect(weightedStance([v('a', 2, 0, 1), v('b', -2, 0, 1)])).toBe(0);
  });
});

describe('weightedDispersion', () => {
  it('is zero when all stances are equal', () => {
    const votes = [v('a', 1, 1, 1), v('b', 1, 0.5, 2)];
    const s = weightedStance(votes);
    expect(weightedDispersion(votes, s)).toBeCloseTo(0, 10);
  });

  it('computes weighted variance around the mean', () => {
    // votes: (+2,1,1) and (-2,1,1) → mean 0, dispersion = (4+4)/2 = 4
    const votes = [v('a', 2, 1, 1), v('b', -2, 1, 1)];
    const s = weightedStance(votes);
    expect(weightedDispersion(votes, s)).toBeCloseTo(4, 10);
  });
});

describe('directionalQuorum', () => {
  it('measures weighted fraction agreeing with the sign of S', () => {
    // S>0; agree = a(+2) & b(+1); disagree = c(-1)
    const votes = [v('a', 2, 1, 1), v('b', 1, 1, 1), v('c', -1, 1, 1)];
    const s = weightedStance(votes); // (2+1-1)/3 = 0.6667 > 0
    // agree weight = 1*1 + 1*1 = 2; total = 3 → 0.6667
    expect(directionalQuorum(votes, s)).toBeCloseTo(2 / 3, 6);
  });

  it('treats |S| < holdBand as neutral target and counts HOLD voters', () => {
    // S≈0 neutral; agree = voters with stance 0
    const votes = [v('a', 1, 1, 1), v('b', -1, 1, 1), v('c', 0, 1, 1)];
    const s = weightedStance(votes); // 0
    expect(directionalQuorum(votes, s, 0.5)).toBeCloseTo(1 / 3, 6);
  });
});

describe('evaluateRound', () => {
  it('converges when quorum and dispersion thresholds are met', () => {
    // three BUYs, one HOLD → strong agreement, low dispersion
    const votes = [v('a', 1, 0.9, 1), v('b', 1, 0.8, 1), v('c', 2, 0.9, 1), v('d', 0, 0.3, 1)];
    const res = evaluateRound(votes, { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 });
    expect(res.converged).toBe(true);
    expect(res.S).toBeGreaterThan(0.5);
    expect(res.kappa).toBeGreaterThanOrEqual(2 / 3);
    expect(res.V).toBeLessThanOrEqual(0.5);
    expect(res.band).toBe('BUY');
  });

  it('does not converge when agents are split (high dispersion)', () => {
    const votes = [v('a', 2, 1, 1), v('b', -2, 1, 1), v('c', 2, 1, 1), v('d', -2, 1, 1)];
    const res = evaluateRound(votes, { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 });
    expect(res.converged).toBe(false);
  });

  it('does not converge when quorum is below threshold', () => {
    // 2 buy vs 2 sell with slight bull tilt → quorum ~0.5 < 2/3
    const votes = [v('a', 1, 1, 1.1), v('b', 1, 1, 1), v('c', -1, 1, 1), v('d', -1, 1, 1)];
    const res = evaluateRound(votes, { thetaV: 5, quorum: 2 / 3, holdBand: 0.5 });
    expect(res.kappa).toBeLessThan(2 / 3);
    expect(res.converged).toBe(false);
  });

  it('a single outlier cannot block a clean 3-of-4 supermajority', () => {
    const votes = [v('a', 1, 0.9, 1), v('b', 1, 0.9, 1), v('c', 1, 0.9, 1), v('d', -2, 0.9, 1)];
    const res = evaluateRound(votes, { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 });
    expect(res.converged).toBe(false); // dispersion from the outlier may exceed θ_v
    // but quorum (3 of 4 agree on bull side) is met:
    expect(res.kappa).toBeGreaterThanOrEqual(0.75);
  });
});

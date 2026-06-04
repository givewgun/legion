import { describe, it, expect } from 'vitest';
import { STANCE, isValidStance, sideOf, stanceBand } from '../../src/consensus/stance.js';

describe('stance', () => {
  it('defines the five ordinal stances', () => {
    expect(STANCE).toEqual({
      STRONG_SELL: -2,
      SELL: -1,
      HOLD: 0,
      BUY: 1,
      STRONG_BUY: 2,
    });
  });

  it('validates stance integers', () => {
    expect(isValidStance(-2)).toBe(true);
    expect(isValidStance(2)).toBe(true);
    expect(isValidStance(0)).toBe(true);
    expect(isValidStance(3)).toBe(false);
    expect(isValidStance(1.5)).toBe(false);
    expect(isValidStance('1')).toBe(false);
  });

  it('returns the directional side of a stance', () => {
    expect(sideOf(2)).toBe(1);
    expect(sideOf(1)).toBe(1);
    expect(sideOf(0)).toBe(0);
    expect(sideOf(-1)).toBe(-1);
    expect(sideOf(-2)).toBe(-1);
  });

  it('maps an aggregate score to a band label using holdBand', () => {
    expect(stanceBand(1.6, 0.5)).toBe('STRONG_BUY');
    expect(stanceBand(0.9, 0.5)).toBe('BUY');
    expect(stanceBand(0.4, 0.5)).toBe('HOLD');
    expect(stanceBand(-0.4, 0.5)).toBe('HOLD');
    expect(stanceBand(-0.9, 0.5)).toBe('SELL');
    expect(stanceBand(-1.6, 0.5)).toBe('STRONG_SELL');
  });
});

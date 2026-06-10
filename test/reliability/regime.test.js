import { describe, it, expect } from 'vitest';
import { classifyRegime, REGIMES } from '../../src/reliability/regime.js';

describe('classifyRegime', () => {
  it('classifies low VIX as calm and high VIX as stressed', () => {
    expect(classifyRegime(12)).toBe('calm');
    expect(classifyRegime(19.9)).toBe('calm');
    expect(classifyRegime(20)).toBe('stressed');
    expect(classifyRegime(35)).toBe('stressed');
  });

  it('returns unknown when VIX is missing or non-numeric', () => {
    expect(classifyRegime(null)).toBe('unknown');
    expect(classifyRegime(undefined)).toBe('unknown');
    expect(classifyRegime('n/a')).toBe('unknown');
  });

  it('never buckets the unknown regime', () => {
    expect(REGIMES).not.toContain('unknown');
  });
});

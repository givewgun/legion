import { describe, it, expect } from 'vitest';
import { constraintSubject, constraintWildcard } from '../../src/bus/subjects.js';

describe('constraint subjects', () => {
  it('builds a per-ticker per-round constraint subject', () => {
    expect(constraintSubject('NVDA', 2)).toBe('legion.constraint.NVDA.2');
  });

  it('uppercases the ticker', () => {
    expect(constraintSubject('mu', 1)).toBe('legion.constraint.MU.1');
  });

  it('exposes a trailing wildcard for the emitter', () => {
    expect(constraintWildcard()).toBe('legion.constraint.>');
  });
});

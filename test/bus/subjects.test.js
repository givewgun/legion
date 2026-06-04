import { describe, it, expect } from 'vitest';
import { cycleSubject, voteSubject, consensusSubject } from '../../src/bus/subjects.js';

describe('subjects', () => {
  it('builds a cycle subject for a ticker', () => {
    expect(cycleSubject('NVDA')).toBe('legion.cycle.NVDA');
  });

  it('builds a vote subject scoped to ticker and round', () => {
    expect(voteSubject('NVDA', 2)).toBe('legion.vote.NVDA.2');
  });

  it('builds a consensus subject for a ticker', () => {
    expect(consensusSubject('NVDA')).toBe('legion.consensus.NVDA');
  });

  it('uppercases the ticker', () => {
    expect(cycleSubject('nvda')).toBe('legion.cycle.NVDA');
    expect(voteSubject('mu', 1)).toBe('legion.vote.MU.1');
  });
});

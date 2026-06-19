import { describe, it, expect } from 'vitest';
import { createVote, validateVote } from '../../src/consensus/vote.js';

describe('vote', () => {
  it('creates a normalized vote object', () => {
    const v = createVote({
      agentId: 'technical',
      stance: 1,
      conviction: 0.8,
      weight: 1.2,
      rationale: 'uptrend intact',
    });
    expect(v).toEqual({
      agentId: 'technical',
      stance: 1,
      conviction: 0.8,
      weight: 1.2,
      rationale: 'uptrend intact',
      model: null,
    });
  });

  it('accepts a valid vote', () => {
    const v = createVote({ agentId: 'a', stance: -2, conviction: 0, weight: 1, rationale: 'x' });
    expect(validateVote(v)).toEqual({ ok: true, errors: [] });
  });

  it('rejects an invalid stance', () => {
    const v = { agentId: 'a', stance: 5, conviction: 0.5, weight: 1, rationale: 'x' };
    const res = validateVote(v);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('stance must be an integer in [-2,2]');
  });

  it('rejects conviction outside [0,1]', () => {
    const v = { agentId: 'a', stance: 1, conviction: 1.4, weight: 1, rationale: 'x' };
    const res = validateVote(v);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('conviction must be a number in [0,1]');
  });

  it('rejects non-positive weight', () => {
    const v = { agentId: 'a', stance: 1, conviction: 0.5, weight: 0, rationale: 'x' };
    const res = validateVote(v);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('weight must be a positive number');
  });

  it('rejects missing agentId', () => {
    const v = { agentId: '', stance: 1, conviction: 0.5, weight: 1, rationale: 'x' };
    const res = validateVote(v);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('agentId must be a non-empty string');
  });
});

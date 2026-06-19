import { describe, it, expect } from 'vitest';
import { parseVote } from '../../../src/agents/technical/parse.js';

const ctx = { agentId: 'technical', weight: 1.0 };

describe('parseVote', () => {
  it('parses a clean JSON object', () => {
    const text = '{"stance": 1, "conviction": 0.8, "rationale": "uptrend"}';
    const res = parseVote(text, ctx);
    expect(res.ok).toBe(true);
    expect(res.vote).toEqual({
      agentId: 'technical',
      stance: 1,
      conviction: 0.8,
      weight: 1.0,
      rationale: 'uptrend',
      model: null,
    });
  });

  it('extracts JSON wrapped in code fences and prose', () => {
    const text =
      'Here is my call:\n```json\n{"stance": -2, "conviction": 0.6, "rationale": "breakdown"}\n```\nThanks.';
    const res = parseVote(text, ctx);
    expect(res.ok).toBe(true);
    expect(res.vote.stance).toBe(-2);
    expect(res.vote.rationale).toBe('breakdown');
  });

  it('fails on unparseable text', () => {
    const res = parseVote('no json here', ctx);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('no JSON object found in LLM output');
  });

  it('fails validation on an out-of-range stance', () => {
    const res = parseVote('{"stance": 9, "conviction": 0.5, "rationale": "x"}', ctx);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('stance must be an integer in [-2,2]');
  });

  it('clamps missing rationale to empty string', () => {
    const res = parseVote('{"stance": 0, "conviction": 0.3}', ctx);
    expect(res.ok).toBe(true);
    expect(res.vote.rationale).toBe('');
  });
});

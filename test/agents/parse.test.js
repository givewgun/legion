import { describe, it, expect } from 'vitest';
import { parseVote } from '../../src/agents/parse.js';

const ctx = { agentId: 'news', weight: 1.0 };

describe('shared parseVote', () => {
  it('parses a clean JSON object', () => {
    const res = parseVote('{"stance": 1, "conviction": 0.7, "rationale": "guidance raise"}', ctx);
    expect(res.ok).toBe(true);
    expect(res.vote).toEqual({
      agentId: 'news',
      stance: 1,
      conviction: 0.7,
      weight: 1.0,
      rationale: 'guidance raise',
      model: null,
    });
  });

  it('extracts JSON from fenced prose', () => {
    const res = parseVote(
      'call:\n```json\n{"stance": -1, "conviction": 0.4, "rationale": "soft"}\n```',
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.vote.stance).toBe(-1);
  });

  it('takes the first complete object when trailing prose adds another brace', () => {
    const res = parseVote(
      '{"stance": 2, "conviction": 0.8, "rationale": "breakout"} Note: ignore {this}.',
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.vote).toMatchObject({ stance: 2, conviction: 0.8, rationale: 'breakout' });
  });

  it('does not miscount braces inside a string value', () => {
    const res = parseVote('{"stance": -1, "conviction": 0.5, "rationale": "sell } now"}', ctx);
    expect(res.ok).toBe(true);
    expect(res.vote.rationale).toBe('sell } now');
  });

  it('skips a leading prose brace and finds the real object', () => {
    const res = parseVote(
      'Here {is my call}: {"stance": 1, "conviction": 0.6, "rationale": "ok"}',
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.vote.stance).toBe(1);
  });

  it('fails on no JSON', () => {
    const res = parseVote('no json', ctx);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('no JSON object found in LLM output');
  });

  it('defaults missing rationale to empty string', () => {
    const res = parseVote('{"stance": 0, "conviction": 0.2}', ctx);
    expect(res.ok).toBe(true);
    expect(res.vote.rationale).toBe('');
  });

  it('tags the vote with the served model', () => {
    const text = '{"stance": 1, "conviction": 0.7, "rationale": "ok"}';
    const { ok, vote } = parseVote(text, { agentId: 'news', weight: 1.2, model: 'gpt-oss:20b' });
    expect(ok).toBe(true);
    expect(vote.model).toBe('gpt-oss:20b');
  });

  it('defaults model to null when not supplied', () => {
    const { vote } = parseVote('{"stance":0,"conviction":0,"rationale":"x"}', {
      agentId: 'news',
      weight: 1,
    });
    expect(vote.model).toBeNull();
  });
});

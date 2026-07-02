import { describe, it, expect } from 'vitest';
import { parseVote, splitThinking, truncateThought } from '../../src/agents/parse.js';

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
      thought: null,
      model: null,
      source: null,
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

  it('threads source onto the parsed vote', () => {
    const text = '{"stance":1,"conviction":0.6,"rationale":"ok"}';
    const { vote } = parseVote(text, { agentId: 'news', weight: 1, model: 'm', source: 'pc' });
    expect(vote.source).toBe('pc');
    expect(vote.model).toBe('m');
  });

  it('threads a thought onto the parsed vote', () => {
    const text = '{"stance":1,"conviction":0.6,"rationale":"ok"}';
    const { vote } = parseVote(text, { agentId: 'news', weight: 1, thought: 'my reasoning' });
    expect(vote.thought).toBe('my reasoning');
  });
});

describe('splitThinking', () => {
  it('splits an inline <think> block out of the answer', () => {
    const raw =
      '<think>RSI is 78, extended</think>{"stance":-1,"conviction":0.6,"rationale":"hot"}';
    const { thought, text } = splitThinking(raw);
    expect(thought).toBe('RSI is 78, extended');
    expect(text).toBe('{"stance":-1,"conviction":0.6,"rationale":"hot"}');
  });

  it('joins multiple blocks and returns null thought when there are none', () => {
    const raw = '<think>a</think>mid<think>b</think>end';
    expect(splitThinking(raw)).toEqual({ thought: 'a\n\nb', text: 'midend' });
    expect(splitThinking('plain answer')).toEqual({ thought: null, text: 'plain answer' });
  });

  it('captures an unterminated <think> block to end-of-text', () => {
    const { thought, text } = splitThinking('<think>ran out of tokens');
    expect(thought).toBe('ran out of tokens');
    expect(text).toBe('');
  });

  it('drops an empty <think></think> block without recording a thought', () => {
    expect(splitThinking('<think>  </think>answer')).toEqual({ thought: null, text: 'answer' });
  });
});

describe('truncateThought', () => {
  it('passes short thoughts and null through unchanged', () => {
    expect(truncateThought('short', 10)).toBe('short');
    expect(truncateThought(null, 10)).toBeNull();
    expect(truncateThought(undefined, 10)).toBeNull();
  });

  it('truncates a long thought with a marker', () => {
    expect(truncateThought('abcdef', 3)).toBe('abc… [truncated]');
  });
});

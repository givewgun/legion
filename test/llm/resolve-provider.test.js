import { describe, it, expect } from 'vitest';
import { resolveProvider, withAgentOptions, DEFAULT_MODELS } from '../../src/llm/provider.js';

describe('withAgentOptions', () => {
  it('overlays sampling options onto the ollama config block', () => {
    const cfg = { ollama: { url: 'http://o:11434', model: 'm' }, other: 1 };
    const out = withAgentOptions(cfg, { temperature: 0.2, seed: 11 });
    expect(out.ollama).toEqual({
      url: 'http://o:11434',
      model: 'm',
      options: { temperature: 0.2, seed: 11 },
    });
    expect(out.other).toBe(1);
    expect(cfg.ollama.options).toBeUndefined(); // input not mutated
  });

  it('returns the config unchanged when the agent has no options', () => {
    const cfg = { ollama: { url: 'u' } };
    expect(withAgentOptions(cfg, null)).toBe(cfg);
  });
});

describe('resolveProvider', () => {
  it('fills the default model when none is given', () => {
    const calls = [];
    const fakeFactory = (opts) => {
      calls.push(opts);
      return { generate: async () => '' };
    };
    resolveProvider({ provider: 'local', model: null }, fakeFactory);
    expect(calls[0]).toEqual({ type: 'local', model: DEFAULT_MODELS.local });
  });

  it('passes an explicit model through', () => {
    const calls = [];
    const fakeFactory = (opts) => {
      calls.push(opts);
      return { generate: async () => '' };
    };
    resolveProvider({ provider: 'gemini', model: 'gemini-2.5-pro' }, fakeFactory);
    expect(calls[0]).toEqual({ type: 'gemini', model: 'gemini-2.5-pro' });
  });

  it('defaults to local for an unknown provider name', () => {
    const calls = [];
    const fakeFactory = (opts) => {
      calls.push(opts);
      return { generate: async () => '' };
    };
    resolveProvider({ provider: 'bogus', model: null }, fakeFactory);
    expect(calls[0].type).toBe('local');
  });
});

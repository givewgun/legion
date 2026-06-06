import { describe, it, expect } from 'vitest';
import { resolveProvider, DEFAULT_MODELS } from '../../src/llm/provider.js';

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

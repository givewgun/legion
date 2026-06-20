import { describe, it, expect, vi } from 'vitest';
import {
  resolveProvider,
  withAgentOptions,
  DEFAULT_MODELS,
  createProvider,
  normalizeGenerate,
  modelKey,
} from '../../src/llm/provider.js';

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

// Build a fake Ollama clientFactory that returns a scripted streaming response.
function fakeOllamaClientFactory(responseText) {
  return (_opts) => ({
    generate: async () => {
      let done = false;
      const iterator = (async function* () {
        if (!done) {
          done = true;
          yield { response: responseText };
        }
      })();
      iterator.abort = () => {};
      return iterator;
    },
  });
}

describe('tiered local wiring', () => {
  const baseCfg = {
    ollama: { url: 'http://oracle:11434', model: 'qwen2.5:7b-instruct' },
    home: { url: '', model: 'gpt-oss:20b', think: null, probeTimeoutMs: 1500, enabled: true },
  };

  it('returns a plain ollama provider (string generate) when home url is empty', async () => {
    const clientFactory = fakeOllamaClientFactory('hi');
    const p = createProvider('local', baseCfg, fetch, clientFactory);
    const out = await p.generate({ system: 's', prompt: 'p' });
    expect(out).toBe('hi'); // plain string contract preserved
    expect(p.model).toBe('qwen2.5:7b-instruct');
  });

  it('returns a tiered provider when home url is set and enabled', async () => {
    const cfg = { ...baseCfg, home: { ...baseCfg.home, url: 'http://pc:11434' } };
    // probe (GET /api/tags) is checked via fetchImpl; generate goes through clientFactory
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/api/tags')) return { ok: true };
      return { ok: true };
    });
    const clientFactory = fakeOllamaClientFactory('from-pc');
    const p = createProvider('local', cfg, fetchImpl, clientFactory);
    const out = await p.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({ text: 'from-pc', model: 'gpt-oss:20b' });
  });

  it('stays pure-Oracle when home.enabled is false even if url set', async () => {
    const cfg = { ...baseCfg, home: { ...baseCfg.home, url: 'http://pc:11434', enabled: false } };
    const clientFactory = fakeOllamaClientFactory('oracle');
    const p = createProvider('local', cfg, fetch, clientFactory);
    await p.generate({ system: 's', prompt: 'p' });
    expect(p.model).toBe('qwen2.5:7b-instruct');
  });
});

describe('normalizeGenerate', () => {
  it('wraps a string result with the provider model', async () => {
    const provider = { model: 'm', generate: async () => 'txt' };
    expect(await normalizeGenerate(provider, {})).toEqual({ text: 'txt', model: 'm' });
  });
  it('passes through an object result', async () => {
    const provider = { model: 'm', generate: async () => ({ text: 't', model: 'pc' }) };
    expect(await normalizeGenerate(provider, {})).toEqual({ text: 't', model: 'pc' });
  });
});

describe('modelKey', () => {
  it('joins agent and model with a NUL separator', () => {
    expect(modelKey('news', 'gpt-oss:20b')).toBe('news gpt-oss:20b');
  });
});

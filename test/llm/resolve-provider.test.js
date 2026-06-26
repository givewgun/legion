import { describe, it, expect, vi } from 'vitest';
import {
  resolveProvider,
  withAgentOptions,
  withModel,
  DEFAULT_MODELS,
  createProvider,
  normalizeGenerate,
  modelKey,
} from '../../src/llm/provider.js';

describe('withModel', () => {
  it('routes an explicit local model to the PC tier only, leaving Oracle its own model', () => {
    // Tiered (home.url set): the chosen model is the PC primary's. The Oracle fallback
    // keeps its CPU-sized model so a fail-over does not try to run the big PC model.
    const cfg = { ollama: { url: 'o', model: 'oracle-m' }, home: { url: 'pc', model: 'home-m' } };
    const out = withModel(cfg, 'local', 'chosen');
    expect(out.ollama.model).toBe('oracle-m'); // fallback unchanged — no 300000ms timeout
    expect(out.home.model).toBe('chosen'); // PC primary honors the per-agent model
    expect(cfg.home.model).toBe('home-m'); // input not mutated
  });

  it('applies an explicit local model to Oracle when the PC tier is not configured', () => {
    const cfg = { ollama: { url: 'o', model: 'oracle-m' }, home: { url: '', model: 'home-m' } };
    const out = withModel(cfg, 'local', 'chosen');
    expect(out.ollama.model).toBe('chosen'); // non-tiered: 'local' IS Oracle
  });

  it('applies an explicit local model to Oracle when the PC tier is disabled', () => {
    const cfg = {
      ollama: { url: 'o', model: 'oracle-m' },
      home: { url: 'pc', model: 'home-m', enabled: false },
    };
    const out = withModel(cfg, 'local', 'chosen');
    expect(out.ollama.model).toBe('chosen');
  });

  it('keeps the configured models when no model is given', () => {
    const cfg = { ollama: { url: 'o', model: 'oracle-m' }, home: { url: 'pc', model: 'home-m' } };
    const out = withModel(cfg, 'local', null);
    expect(out.ollama.model).toBe('oracle-m'); // not clobbered by a hardcoded default
    expect(out.home.model).toBe('home-m');
  });
});

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
  it('passes a null model through to the factory (factory decides the default)', () => {
    const calls = [];
    const fakeFactory = (opts) => {
      calls.push(opts);
      return { generate: async () => '' };
    };
    resolveProvider({ provider: 'local', model: null }, fakeFactory);
    expect(calls[0]).toEqual({ type: 'local', model: null });
  });

  it('fills the family default via the cfg-less default factory', () => {
    const p = resolveProvider({ provider: 'local', model: null });
    expect(p.model).toBe(DEFAULT_MODELS.local);
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
    // probe (GET /ready) is checked via fetchImpl; generate goes through clientFactory
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/ready')) return { ok: true, json: async () => ({ ready: true }) };
      return { ok: true };
    });
    const clientFactory = fakeOllamaClientFactory('from-pc');
    const p = createProvider('local', cfg, fetchImpl, clientFactory);
    const out = await p.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({ text: 'from-pc', model: 'gpt-oss:20b', source: 'pc' });
  });

  it('falls back to Oracle when /ready reports ready:false (PC busy-gated)', async () => {
    const cfg = { ...baseCfg, home: { ...baseCfg.home, url: 'http://pc:11434' } };
    // /ready answers (PC reachable) but busy-gated -> ready:false -> Oracle, not the PC.
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/ready')) return { ok: true, json: async () => ({ ready: false }) };
      return { ok: true };
    });
    const clientFactory = fakeOllamaClientFactory('from-oracle');
    const p = createProvider('local', cfg, fetchImpl, clientFactory);
    const out = await p.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({ text: 'from-oracle', model: 'qwen2.5:7b-instruct', source: 'oracle' });
  });

  it('retries a transient readiness-probe miss before committing, then uses the PC', async () => {
    // A single slow/cold Tailscale hop must not dump the whole sweep onto the slow
    // Oracle: a transient probe miss (timeout/network) is retried before failing over.
    const cfg = { ...baseCfg, home: { ...baseCfg.home, url: 'http://pc:11434', probeRetryGapMs: 0 } };
    let readyCalls = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/ready')) {
        readyCalls++;
        if (readyCalls === 1) throw new Error('UND_ERR_CONNECT_TIMEOUT'); // cold hop
        return { ok: true, json: async () => ({ ready: true }) };
      }
      return { ok: true };
    });
    const clientFactory = fakeOllamaClientFactory('from-pc');
    const p = createProvider('local', cfg, fetchImpl, clientFactory);
    const out = await p.generate({ system: 's', prompt: 'p' });
    expect(out.source).toBe('pc'); // did not give up to Oracle on the first transient miss
    expect(readyCalls).toBeGreaterThanOrEqual(2);
  });

  it('does NOT retry a definitive ready:false (busy-gated) — goes straight to Oracle', async () => {
    const cfg = { ...baseCfg, home: { ...baseCfg.home, url: 'http://pc:11434', probeRetryGapMs: 0 } };
    let readyCalls = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/ready')) {
        readyCalls++;
        return { ok: true, json: async () => ({ ready: false }) };
      }
      return { ok: true };
    });
    const clientFactory = fakeOllamaClientFactory('from-oracle');
    const p = createProvider('local', cfg, fetchImpl, clientFactory);
    const out = await p.generate({ system: 's', prompt: 'p' });
    expect(out.source).toBe('oracle');
    expect(readyCalls).toBe(1); // a clear "I'm gaming" answer is respected immediately
  });

  it('falls back to Oracle when the /ready probe errors (PC offline)', async () => {
    const cfg = { ...baseCfg, home: { ...baseCfg.home, url: 'http://pc:11434' } };
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const clientFactory = fakeOllamaClientFactory('from-oracle');
    const p = createProvider('local', cfg, fetchImpl, clientFactory);
    const out = await p.generate({ system: 's', prompt: 'p' });
    expect(out.source).toBe('oracle');
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
    expect(await normalizeGenerate(provider, {})).toEqual({ text: 'txt', model: 'm', source: null });
  });
  it('passes through an object result', async () => {
    const provider = { model: 'm', generate: async () => ({ text: 't', model: 'pc' }) };
    expect(await normalizeGenerate(provider, {})).toEqual({ text: 't', model: 'pc' });
  });
});

describe('normalizeGenerate source', () => {
  it('passes a tiered object source through unchanged', async () => {
    const provider = { generate: async () => ({ text: 't', model: 'm', source: 'pc' }) };
    expect(await normalizeGenerate(provider, {})).toEqual({ text: 't', model: 'm', source: 'pc' });
  });
  it('reads source off a string-returning provider', async () => {
    const provider = { model: 'm', source: 'oracle', generate: async () => 'hi' };
    expect(await normalizeGenerate(provider, {})).toEqual({ text: 'hi', model: 'm', source: 'oracle' });
  });
});

describe('modelKey', () => {
  it('joins agent and model with a NUL separator', () => {
    expect(modelKey('news', 'gpt-oss:20b')).toBe('news gpt-oss:20b');
  });
});

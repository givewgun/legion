import { describe, it, expect, vi } from 'vitest';
import { createTieredProvider } from '../../src/llm/tiered.js';

const stub = (model, source, impl) => ({
  name: 'local',
  model,
  source,
  generate: vi.fn(impl ?? (async () => `from-${model}`)),
});

describe('createTieredProvider', () => {
  it('routes to the primary when enabled and probe is ready', async () => {
    const primary = stub('gpt-oss:20b', 'pc');
    const fallback = stub('qwen2.5:7b-instruct', 'oracle');
    const t = createTieredProvider({
      primary,
      fallback,
      probe: async () => true,
      isEnabled: () => true,
    });
    const out = await t.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({ text: 'from-gpt-oss:20b', thinking: null, model: 'gpt-oss:20b', source: 'pc' });
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it('routes to the fallback when the probe is not ready', async () => {
    const primary = stub('gpt-oss:20b', 'pc');
    const fallback = stub('qwen2.5:7b-instruct', 'oracle');
    const t = createTieredProvider({ primary, fallback, probe: async () => false });
    const out = await t.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({
      text: 'from-qwen2.5:7b-instruct',
      thinking: null,
      model: 'qwen2.5:7b-instruct',
      source: 'oracle',
    });
    expect(primary.generate).not.toHaveBeenCalled();
  });

  it('routes to the fallback when the global toggle is off (no probe)', async () => {
    const primary = stub('gpt-oss:20b', 'pc');
    const fallback = stub('qwen2.5:7b-instruct', 'oracle');
    const probe = vi.fn(async () => true);
    const t = createTieredProvider({ primary, fallback, probe, isEnabled: () => false });
    const out = await t.generate({ system: 's', prompt: 'p' });
    expect(out.model).toBe('qwen2.5:7b-instruct');
    expect(probe).not.toHaveBeenCalled();
  });

  it('does NOT fail over to Oracle when the PC is available and the call throws', async () => {
    // PC-preferred: once the probe says the PC is available we commit to it and
    // queue. A PC error propagates (agent abstains) — we never load-shed to Oracle.
    const primary = stub('gpt-oss:20b', 'pc', async () => {
      throw new Error('Ollama request timed out after 1800000ms');
    });
    const fallback = stub('qwen2.5:7b-instruct', 'oracle');
    const t = createTieredProvider({ primary, fallback, probe: async () => true });
    await expect(t.generate({ system: 's', prompt: 'p' })).rejects.toThrow(/timed out/);
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it('pins the PC (never Oracle) when allowFallback is false, even if the probe is not ready', async () => {
    const primary = stub('qwen3:14b', 'pc');
    const fallback = stub('qwen2.5:7b-instruct', 'oracle');
    const probe = vi.fn(async () => false);
    const t = createTieredProvider({ primary, fallback, probe, allowFallback: false });
    const out = await t.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({ text: 'from-qwen3:14b', thinking: null, model: 'qwen3:14b', source: 'pc' });
    expect(fallback.generate).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('passes a tier\'s { text, thinking } reply through with the tier tags', async () => {
    const primary = stub('qwen3:8b', 'pc', async () => ({
      text: 'BUY',
      thinking: 'the math says overvalued peers, not this one',
    }));
    const fallback = stub('qwen2.5:7b-instruct', 'oracle');
    const t = createTieredProvider({ primary, fallback, probe: async () => true });
    const out = await t.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({
      text: 'BUY',
      thinking: 'the math says overvalued peers, not this one',
      model: 'qwen3:8b',
      source: 'pc',
    });
  });

  it('propagates a PC error when pinned (allowFallback false) — no Oracle rescue', async () => {
    const primary = stub('qwen3:14b', 'pc', async () => {
      throw new Error('Ollama request timed out after 3600000ms');
    });
    const fallback = stub('qwen2.5:7b-instruct', 'oracle');
    const t = createTieredProvider({ primary, fallback, probe: async () => true, allowFallback: false });
    await expect(t.generate({ system: 's', prompt: 'p' })).rejects.toThrow(/timed out/);
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it('advertises the primary model as .model', () => {
    const t = createTieredProvider({ primary: stub('gpt-oss:20b', 'oracle'), fallback: stub('x', 'oracle') });
    expect(t.model).toBe('gpt-oss:20b');
  });
});

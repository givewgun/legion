import { describe, it, expect, vi } from 'vitest';
import { createTieredProvider } from '../../src/llm/tiered.js';

const stub = (model, impl) => ({
  name: 'local',
  model,
  generate: vi.fn(impl ?? (async () => `from-${model}`)),
});

describe('createTieredProvider', () => {
  it('routes to the primary when enabled and probe is ready', async () => {
    const primary = stub('gpt-oss:20b');
    const fallback = stub('qwen2.5:7b-instruct');
    const t = createTieredProvider({
      primary,
      fallback,
      probe: async () => true,
      isEnabled: () => true,
    });
    const out = await t.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({ text: 'from-gpt-oss:20b', model: 'gpt-oss:20b' });
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it('routes to the fallback when the probe is not ready', async () => {
    const primary = stub('gpt-oss:20b');
    const fallback = stub('qwen2.5:7b-instruct');
    const t = createTieredProvider({ primary, fallback, probe: async () => false });
    const out = await t.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({ text: 'from-qwen2.5:7b-instruct', model: 'qwen2.5:7b-instruct' });
    expect(primary.generate).not.toHaveBeenCalled();
  });

  it('routes to the fallback when the global toggle is off (no probe)', async () => {
    const primary = stub('gpt-oss:20b');
    const fallback = stub('qwen2.5:7b-instruct');
    const probe = vi.fn(async () => true);
    const t = createTieredProvider({ primary, fallback, probe, isEnabled: () => false });
    const out = await t.generate({ system: 's', prompt: 'p' });
    expect(out.model).toBe('qwen2.5:7b-instruct');
    expect(probe).not.toHaveBeenCalled();
  });

  it('fails over to the fallback when the primary throws mid-call', async () => {
    const primary = stub('gpt-oss:20b', async () => {
      throw new Error('Ollama request timed out after 1500ms');
    });
    const fallback = stub('qwen2.5:7b-instruct');
    const t = createTieredProvider({ primary, fallback, probe: async () => true });
    const out = await t.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({ text: 'from-qwen2.5:7b-instruct', model: 'qwen2.5:7b-instruct' });
  });

  it('advertises the primary model as .model', () => {
    const t = createTieredProvider({ primary: stub('gpt-oss:20b'), fallback: stub('x') });
    expect(t.model).toBe('gpt-oss:20b');
  });
});

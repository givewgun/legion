import { describe, it, expect, vi } from 'vitest';
import { createOllamaProvider } from '../../src/llm/ollama.js';
import { createProvider } from '../../src/llm/provider.js';

describe('createOllamaProvider', () => {
  it('posts system+prompt to the Ollama generate endpoint and returns the text', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ response: 'BUY: trend up' }),
    }));
    const provider = createOllamaProvider(
      { url: 'http://ollama:11434', model: 'qwen2.5:7b-instruct' },
      fetchMock,
    );
    const out = await provider.generate({ system: 'You are a trader', prompt: 'Rate NVDA' });
    expect(out).toBe('BUY: trend up');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://ollama:11434/api/generate');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('qwen2.5:7b-instruct');
    expect(body.system).toBe('You are a trader');
    expect(body.prompt).toBe('Rate NVDA');
    expect(body.stream).toBe(false);
  });

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
    const provider = createOllamaProvider({ url: 'http://o:11434', model: 'm' }, fetchMock);
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(
      'Ollama request failed: 500',
    );
  });
});

describe('createProvider', () => {
  it('builds an ollama provider by name', () => {
    const provider = createProvider('local', { ollama: { url: 'http://o:11434', model: 'm' } });
    expect(typeof provider.generate).toBe('function');
  });

  it('throws on an unknown provider name', () => {
    expect(() => createProvider('mystery', {})).toThrow('Unknown LLM provider: mystery');
  });
});

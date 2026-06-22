import { describe, it, expect, vi } from 'vitest';
import { createOpenAICompatProvider } from '../../src/llm/openai.js';
import { createProvider } from '../../src/llm/provider.js';

const okFetch = (content = 'BUY') =>
  vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  }));

const baseCfg = { url: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' };

describe('createOpenAICompatProvider', () => {
  it('posts system+prompt as chat messages with auth and returns the content', async () => {
    const fetchMock = okFetch('BUY: catalyst');
    const provider = createOpenAICompatProvider(baseCfg, fetchMock);
    const out = await provider.generate({ system: 'You are a trader', prompt: 'Rate NVDA' });
    expect(out).toBe('BUY: catalyst');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are a trader' },
      { role: 'user', content: 'Rate NVDA' },
    ]);
  });

  it('passes per-agent sampling options through', async () => {
    const fetchMock = okFetch();
    const provider = createOpenAICompatProvider(
      { ...baseCfg, options: { temperature: 0.2, seed: 11 } },
      fetchMock,
    );
    await provider.generate({ system: 's', prompt: 'p' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBe(0.2);
    expect(body.seed).toBe(11);
  });

  it('omits sampling params when no options are configured', async () => {
    const fetchMock = okFetch();
    const provider = createOpenAICompatProvider(baseCfg, fetchMock);
    await provider.generate({ system: 's', prompt: 'p' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBeUndefined();
    expect(body.seed).toBeUndefined();
  });

  it('throws a clear error when constructed without an API key', () => {
    expect(() => createOpenAICompatProvider({ ...baseCfg, apiKey: '' })).toThrow(
      /requires an API key/,
    );
  });

  it('throws on a non-ok response with the provider name', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
    const provider = createOpenAICompatProvider(
      { ...baseCfg, name: 'gemini', retries: 0 },
      fetchMock,
    );
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(
      'gemini request failed: 401',
    );
  });

  it('throws when the response carries no message content', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [] }) }));
    const provider = createOpenAICompatProvider({ ...baseCfg, retries: 0 }, fetchMock);
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(
      /missing message content/,
    );
  });

  it('retries a transient 5xx then succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    });
    const provider = createOpenAICompatProvider({ ...baseCfg, retries: 1 }, fetchMock);
    await expect(provider.generate({ system: 's', prompt: 'p' })).resolves.toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('createProvider routing', () => {
  it("routes 'openai' and 'gemini' to the OpenAI-compatible provider", () => {
    const cfg = {
      openai: { url: 'u', apiKey: 'k', model: 'm' },
      gemini: { url: 'u', apiKey: 'k', model: 'm' },
    };
    expect(createProvider('openai', cfg).name).toBe('openai');
    expect(createProvider('gemini', cfg).name).toBe('gemini');
  });

  it('still throws for an unknown provider name', () => {
    expect(() => createProvider('bogus', {})).toThrow('Unknown LLM provider: bogus');
  });
});

describe('createOpenAICompatProvider source', () => {
  it('exposes source equal to its name', () => {
    const p = createOpenAICompatProvider({ name: 'gemini', url: 'http://x', apiKey: 'k', model: 'm' });
    expect(p.source).toBe('gemini');
  });
});

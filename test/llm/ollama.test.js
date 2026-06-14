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
    // no sampling options configured -> none sent
    expect(body.options).toBeUndefined();
    // new options: signal must be present; dispatcher optional
    expect(opts.signal).toBeDefined();
  });

  it('omits the think field when not configured', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ response: 'ok' }) }));
    const provider = createOllamaProvider({ url: 'http://o:11434', model: 'm' }, fetchMock);
    await provider.generate({ system: 's', prompt: 'p' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('think');
  });

  it('includes think: false in the request body when configured', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ response: 'ok' }) }));
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', think: false },
      fetchMock,
    );
    await provider.generate({ system: 's', prompt: 'p' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.think).toBe(false);
  });

  it('includes think: true in the request body when configured', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ response: 'ok' }) }));
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', think: true },
      fetchMock,
    );
    await provider.generate({ system: 's', prompt: 'p' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.think).toBe(true);
  });

  it('passes per-agent sampling options (temperature, seed) to the API', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ response: 'ok' }) }));
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', options: { temperature: 0.2, seed: 11 } },
      fetchMock,
    );
    await provider.generate({ system: 's', prompt: 'p' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options).toEqual({ temperature: 0.2, seed: 11 });
  });

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 0 },
      fetchMock,
    );
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(
      'Ollama request failed: 500',
    );
  });

  it('caps concurrency: peak in-flight ≤ maxConcurrent', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          // resolve on next microtask to let others pile up
          setTimeout(() => {
            inFlight -= 1;
            resolve({ ok: true, json: async () => ({ response: 'ok' }) });
          }, 0);
        }),
    );
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', maxConcurrent: 1, retries: 0 },
      fetchMock,
    );
    await Promise.all(
      Array.from({ length: 8 }, () => provider.generate({ system: 's', prompt: 'p' })),
    );
    expect(peak).toBeLessThanOrEqual(1);
  });

  it('retries a transient fetch-failed error then succeeds', async () => {
    const transportErr = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET' },
    });
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      if (calls < 3) throw transportErr;
      return Promise.resolve({ ok: true, json: async () => ({ response: 'recovered' }) });
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 2, maxConcurrent: 1 },
      fetchMock,
    );
    const out = await provider.generate({ system: 's', prompt: 'p' });
    expect(out).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a 503 then succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ ok: false, status: 503 });
      return Promise.resolve({ ok: true, json: async () => ({ response: 'ok after retry' }) });
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 2, maxConcurrent: 1 },
      fetchMock,
    );
    const out = await provider.generate({ system: 's', prompt: 'p' });
    expect(out).toBe('ok after retry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 400 error', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400 }));
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 3, maxConcurrent: 1 },
      fetchMock,
    );
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(
      'Ollama request failed: 400',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out a hung request and does NOT retry', async () => {
    const fetchMock = vi.fn(
      (_url, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
            reject(err);
          });
        }),
    );
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', timeoutMs: 10, retries: 3, maxConcurrent: 1 },
      fetchMock,
    );
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry an undici headers timeout (saturation), surfaces it as a timeout', async () => {
    // Node global fetch reports a headers timeout as TypeError fetch failed with
    // cause.code UND_ERR_HEADERS_TIMEOUT — same 300s saturation our AbortController guards.
    const headersTimeout = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_HEADERS_TIMEOUT' },
    });
    const fetchMock = vi.fn(() => {
      throw headersTimeout;
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 3, maxConcurrent: 1 },
      fetchMock,
    );
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the cause code on exhausted transport errors', async () => {
    const transportErr = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET' },
    });
    const fetchMock = vi.fn(() => {
      throw transportErr;
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 2, maxConcurrent: 1 },
      fetchMock,
    );
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(/ECONNRESET/);
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
